"""Crawl the College's official pages into corpus/.

    .venv/bin/python -m riverguide.crawl            # full crawl, then write corpus/CHECKED
    .venv/bin/python -m riverguide.crawl --url URL  # re-fetch specific pages only

What gets crawled:
  - every page in irsc.edu's sitemaps
  - the College catalog, by following links from its home page
  - every page already in corpus/ (so pages that drop out of a sitemap but
    stay live, like the help-desk guide, stay searchable)

A page is rewritten only when its content changed. A page is deleted only when
the site answers 404 or 410. The crawl fails closed instead of deleting much of
the corpus, or of trusting a sitemap that suddenly shrank.
"""
from __future__ import annotations

import argparse
import datetime as dt
import html
import re
import sys
import time
from collections import deque
from urllib.parse import urldefrag, urljoin, urlsplit
from xml.etree import ElementTree

import requests
from bs4 import BeautifulSoup, Comment
from markdownify import markdownify

from riverguide.corpus import CORPUS_DIR, Page, load_pages, normalize_url, path_for_url, write_checked, write_page

SITEMAPS = tuple(
    f"https://irsc.edu/{name}-sitemap.xml" for name in ("page", "program", "study_area", "landing_page")
)
CATALOG_HOME = "https://irsc.smartcatalogiq.com/en/current/catalog"
CATALOG_SKIP = ("/site-map", "/print", "/search", "/import-settings")
MIN_SITEMAP_URLS = 200
MAX_DELETE_FRACTION = 0.05
DELAY_SECONDS = 0.3
RETRY_STATUSES = {429, 500, 502, 503, 504}
GONE_STATUSES = {404, 410}
USER_AGENT = "Mozilla/5.0 (compatible; RiverGuide-Crawler/2.0; +https://irsc.edu)"

STRIP_TAGS = ("script", "style", "noscript", "nav", "footer", "header", "iframe", "svg", "button", "input", "select", "textarea")
STRIP_SELECTORS = (
    "[role=navigation]", "[role=banner]", "[role=contentinfo]", ".nav", ".navbar", ".menu", ".footer",
    ".header", ".sidebar", ".social", ".share", ".breadcrumb", ".cookie", ".skip-link",
    "#nav", "#footer", "#header", "#sidebar",
)
MAIN_SELECTORS = ("main", "article", "[role=main]", "#main", "#content", ".main-content", ".content", ".entry-content", ".post-content")
BOILERPLATE_LINES = {"skip to main content", "search this guide"}
MOJIBAKE = {
    " ": " ", "Â": "", "â\u0080\u0098": "‘", "â\u0080\u0099": "’",
    "â\u0080\u009c": "“", "â\u0080\u009d": "”", "â\u0080\u0093": "–", "â\u0080\u0094": "—",
}


class Gone(Exception):
    """The site says this page no longer exists (404/410)."""


def fetch(session: requests.Session, url: str, attempts: int = 5) -> str:
    for attempt in range(attempts):
        try:
            response = session.get(url, timeout=30)
        except requests.RequestException:
            if attempt == attempts - 1:
                raise
        else:
            if response.status_code in GONE_STATUSES:
                raise Gone(url)
            if response.status_code not in RETRY_STATUSES:
                response.raise_for_status()
                return response.content.decode("utf-8", errors="replace")
            if attempt == attempts - 1:
                response.raise_for_status()
        time.sleep(min(12.0, 1.5 * 2**attempt))
    raise RuntimeError(f"unreachable: {url}")


def clean_text(value: str) -> str:
    value = html.unescape(value)
    for bad, good in MOJIBAKE.items():
        value = value.replace(bad, good)
    return value


def page_title(url: str, heading: str) -> str:
    """'Parent > Parent > Heading' from the URL's folders, like the catalog's breadcrumbs."""
    path = urlsplit(url).path.strip("/").split("/")
    if url.startswith(CATALOG_HOME):
        parents = ["Catalog", *path[3:-1]]
    else:
        parents = path[:-1]
    crumbs = [p if p == "Catalog" else p.replace("-", " ").replace("_", " ").title() for p in parents if p and not p.isdigit()]
    return " > ".join([*crumbs, heading]) if heading else " > ".join(crumbs)


def _span(cell, attribute: str) -> int:
    value = str(cell.attrs.pop(attribute, "1")).strip()
    return int(value) if value.isdigit() and int(value) > 0 else 1


def expand_table_spans(soup: BeautifulSoup) -> None:
    """Give every table row its full set of cells before converting to markdown.

    Markdown tables have no rowspan or colspan, and markdownify ignores them, so the
    row under a rowspan cell slides one column left. On the Summer 2027 calendar that
    put Summer B's dates under "Summer A". Spanned positions become empty cells.
    """
    for table in soup.find_all("table"):
        carry: dict[int, int] = {}  # column -> rows still covered by a rowspan above
        for row in table.find_all("tr"):
            if row.find_parent("table") is not table:
                continue  # nested table: handled on its own
            col = 0
            for cell in row.find_all(["td", "th"], recursive=False):
                while carry.get(col, 0) > 0:
                    cell.insert_before(soup.new_tag(cell.name))
                    carry[col] -= 1
                    col += 1
                rowspan, colspan = _span(cell, "rowspan"), _span(cell, "colspan")
                for offset in range(colspan):
                    if rowspan > 1:
                        carry[col + offset] = rowspan - 1
                    if offset:
                        cell.insert_after(soup.new_tag(cell.name))
                col += colspan
            while carry.get(col, 0) > 0:
                row.append(soup.new_tag("td"))
                carry[col] -= 1
                col += 1


def extract(url: str, raw_html: str) -> tuple[str, str]:
    """(title, markdown) of a page's main content, with absolute links."""
    soup = BeautifulSoup(raw_html, "lxml")
    for tag in STRIP_TAGS:
        for node in soup.find_all(tag):
            node.decompose()
    for selector in STRIP_SELECTORS:
        for node in soup.select(selector):
            node.decompose()
    for comment in soup.find_all(string=lambda s: isinstance(s, Comment)):
        comment.extract()
    expand_table_spans(soup)
    main = next((node for s in MAIN_SELECTORS if (node := soup.select_one(s))), None) or soup.body or soup
    for link in main.find_all("a", href=True):
        href = link["href"].strip()
        if href.startswith(("javascript:", "#")):
            link.unwrap()
        else:
            link["href"] = urljoin(url, href)
    h1 = main.find("h1") or soup.find("h1")
    heading = clean_text(h1.get_text(" ", strip=True)) if h1 else ""
    if not heading and soup.title:
        heading = clean_text(soup.title.get_text(" ", strip=True)).split(" | ")[0]
    text = markdownify(str(main), heading_style="ATX", bullets="-", strip=["img"])
    text = "\n".join(
        line.rstrip() for line in clean_text(text).splitlines() if line.strip().lower() not in BOILERPLATE_LINES
    )
    return page_title(url, heading), re.sub(r"\n{3,}", "\n\n", text).strip()


def catalog_links(raw_html: str) -> set[str]:
    soup = BeautifulSoup(raw_html, "lxml")
    links = set()
    for anchor in soup.find_all("a", href=True):
        href = urldefrag(urljoin(CATALOG_HOME, anchor["href"]))[0].split("?")[0].rstrip("/")
        if href.startswith(CATALOG_HOME) and not any(skip in href for skip in CATALOG_SKIP):
            links.add(href)
    return links


def sitemap_urls(session: requests.Session) -> set[str]:
    urls: set[str] = set()
    for sitemap in SITEMAPS:
        root = ElementTree.fromstring(fetch(session, sitemap))
        urls |= {loc.text.strip() for loc in root.iter("{http://www.sitemaps.org/schemas/sitemap/0.9}loc") if loc.text}
    if len(urls) < MIN_SITEMAP_URLS:
        raise SystemExit(f"refusing to crawl: sitemaps listed {len(urls)} pages (< {MIN_SITEMAP_URLS})")
    return urls


def crawl(urls: list[str], *, follow_catalog: bool, today: str) -> tuple[int, int, list[str], list[str]]:
    """Fetch pages. Returns (fetched, changed, gone URLs, failed URLs)."""
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    queue = deque(urls)
    seen = {normalize_url(u) for u in urls}
    fetched = changed = 0
    gone: list[str] = []
    failed: list[str] = []
    while queue:
        url = queue.popleft()
        try:
            raw_html = fetch(session, url)
        except Gone:
            gone.append(url)
            continue
        except requests.RequestException as exc:
            print(f"FAIL {url}: {exc}", file=sys.stderr)
            failed.append(url)
            continue
        finally:
            time.sleep(DELAY_SECONDS)
        fetched += 1
        if follow_catalog and url.startswith(CATALOG_HOME):
            for link in sorted(catalog_links(raw_html)):
                if normalize_url(link) not in seen:
                    seen.add(normalize_url(link))
                    queue.append(link)
        title, text = extract(url, raw_html)
        if text and write_page(Page(url=url, title=title, updated=today, text=text)):
            changed += 1
        if fetched % 100 == 0:
            print(f"{fetched} fetched, {changed} changed, {len(queue)} queued", file=sys.stderr)
    return fetched, changed, gone, failed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Crawl official College pages into corpus/.")
    parser.add_argument("--url", action="append", help="re-fetch only these URLs (repeatable)")
    args = parser.parse_args(argv)
    today = dt.date.today().isoformat()

    if args.url:
        fetched, changed, gone, failed = crawl(args.url, follow_catalog=False, today=today)
        print(f"fetched {fetched}, changed {changed}, gone {len(gone)}, failed {len(failed)}")
        return 1 if failed else 0

    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    known = {normalize_url(page.url): page.url for page in load_pages()}
    start = {normalize_url(u): u for u in sitemap_urls(session)}
    start.setdefault(normalize_url(CATALOG_HOME), CATALOG_HOME)
    for key, url in known.items():
        start.setdefault(key, url)
    fetched, changed, gone, failed = crawl(sorted(start.values()), follow_catalog=True, today=today)

    if known and len(gone) > MAX_DELETE_FRACTION * len(known):
        print(f"refusing to delete {len(gone)} pages (> {MAX_DELETE_FRACTION:.0%} of the corpus)", file=sys.stderr)
        return 1
    for url in gone:
        (CORPUS_DIR / path_for_url(url)).unlink(missing_ok=True)
    if failed:
        print(f"{len(failed)} pages failed; corpus/CHECKED not updated", file=sys.stderr)
        return 1
    write_checked(today)
    print(f"fetched {fetched}, changed {changed}, deleted {len(gone)}; checked {today}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
