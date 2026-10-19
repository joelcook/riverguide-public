"""The corpus: one markdown file per official College web page.

A page's path under corpus/ is derived from its URL, so the crawler, the
index, and the tests all agree on where a page lives:

    https://irsc.edu/admissions/apply
        -> corpus/irsc.edu/admissions/apply.md

Each file starts with a small YAML header (url, title, updated) followed by
the page's main content as markdown. `updated` is the date the content last
changed; corpus/CHECKED holds the date of the last full crawl, which confirmed
every page still says what its file says. Nothing here is hand-edited; the
crawler owns it.
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
CORPUS_DIR = REPO_ROOT / "corpus"
CHECKED_FILE = "CHECKED"

_FRONTMATTER_RE = re.compile(r"\A---\n(.*?)\n---\n?", re.DOTALL)
_UNSAFE_SEGMENT_RE = re.compile(r"[^A-Za-z0-9._-]+")


@dataclass(frozen=True)
class Page:
    url: str
    title: str
    updated: str
    text: str


def normalize_url(url: str) -> str:
    """Canonical form for comparing URLs: https, no www, no fragment, no trailing slash."""
    parts = urlsplit(url.strip())
    host = parts.netloc.lower().removeprefix("www.")
    path = parts.path.rstrip("/")
    query = f"?{parts.query}" if parts.query else ""
    return f"https://{host}{path}{query}"


def path_for_url(url: str) -> Path:
    """Relative corpus path for a URL, e.g. irsc.edu/admissions/apply.md."""
    parts = urlsplit(normalize_url(url))
    segments = [
        _UNSAFE_SEGMENT_RE.sub("-", segment).strip("-")
        for segment in parts.path.split("/")
        if segment not in ("", ".", "..")
    ]
    segments = [segment for segment in segments if segment] or ["index"]
    if parts.query:
        segments[-1] += "--" + _UNSAFE_SEGMENT_RE.sub("-", parts.query).strip("-")
    return Path(parts.netloc, *segments[:-1], segments[-1] + ".md")


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


def render_page(page: Page) -> str:
    header = yaml.safe_dump(
        {
            "url": page.url,
            "title": page.title,
            "updated": page.updated,
            "sha": content_hash(page.text),
        },
        sort_keys=False,
        allow_unicode=True,
        width=1000,
    )
    return f"---\n{header}---\n\n{page.text.strip()}\n"


def parse_page(raw: str) -> Page | None:
    match = _FRONTMATTER_RE.match(raw)
    if not match:
        return None
    meta = yaml.safe_load(match.group(1)) or {}
    url = meta.get("url")
    if not isinstance(url, str) or not url:
        return None
    return Page(
        url=url,
        title=str(meta.get("title") or url),
        updated=str(meta.get("updated") or ""),
        text=raw[match.end():].strip(),
    )


def write_page(page: Page, corpus_dir: Path = CORPUS_DIR) -> bool:
    """Write a page if its content changed. Returns True when the file changed."""
    target = corpus_dir / path_for_url(page.url)
    if target.exists():
        existing = parse_page(target.read_text(encoding="utf-8"))
        if existing and content_hash(existing.text) == content_hash(page.text.strip()):
            return False
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(render_page(page), encoding="utf-8")
    return True


def read_checked(corpus_dir: Path = CORPUS_DIR) -> str:
    """Date of the last full crawl that re-checked every page, or '' if unknown."""
    path = corpus_dir / CHECKED_FILE
    return path.read_text(encoding="utf-8").strip() if path.exists() else ""


def write_checked(date: str, corpus_dir: Path = CORPUS_DIR) -> None:
    corpus_dir.mkdir(parents=True, exist_ok=True)
    (corpus_dir / CHECKED_FILE).write_text(f"{date}\n", encoding="utf-8")


def load_pages(corpus_dir: Path = CORPUS_DIR) -> list[Page]:
    pages = []
    for path in sorted(corpus_dir.rglob("*.md")):
        page = parse_page(path.read_text(encoding="utf-8"))
        if page is not None:
            pages.append(page)
    return pages
