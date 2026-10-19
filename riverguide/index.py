"""Full-text search over the corpus: SQLite FTS5 ranked by BM25.

This is RiverGuide's `ground` tool. America.gov lets its model write its own
search queries against a crawled, government-only keyword index and read the
page text it gets back. At College scale (~2,400 pages, ~5 MB of text) the
whole index lives in memory and builds in about a second, so there is no
separate index to keep in sync: the index is a function of corpus/.
"""
from __future__ import annotations

import re
import sqlite3
import threading
from dataclasses import dataclass
from functools import lru_cache

from riverguide.corpus import CORPUS_DIR, Page, load_pages, normalize_url, read_checked

CHUNK_CHARS = 1400
EXCERPT_CHARS = 2200
READ_CHARS = 15000
MAX_RESULTS = 10

# bm25() weights, in table column order: title, section, body.
_WEIGHTS = (8.0, 4.0, 1.0)

_TOKEN_RE = re.compile(r"[^\W_]+", re.UNICODE)
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_STOPWORDS = frozenset(
    """a about an and are as at be been but by can could did do does for from
    get got had has have how i if in into is it its me my of on or our should
    so than that the their them then there these this to was we what when
    where which who why will with would you your""".split()
)


@dataclass(frozen=True)
class Chunk:
    page: int
    section: str
    text: str


def _split_long(block: str, limit: int) -> list[str]:
    """Split an oversized block on line boundaries, then hard-wrap any long line."""
    pieces: list[str] = []
    current = ""
    for line in block.splitlines():
        while len(line) > limit:
            pieces.append(line[:limit])
            line = line[limit:]
        if current and len(current) + len(line) + 1 > limit:
            pieces.append(current)
            current = line
        else:
            current = f"{current}\n{line}" if current else line
    if current:
        pieces.append(current)
    return pieces


_TABLE_SEPARATOR_RE = re.compile(r"^\s*\|[\s:|-]+\|\s*$")


def _cells(row: str) -> list[str]:
    return [c.strip() for c in row.strip().strip("|").split("|")]


def _is_label_row(row: str) -> bool:
    """A row whose filled cells are all bold, like '| **Summer Full Term** | **Summer A** |'."""
    filled = [c for c in _cells(row) if c]
    return bool(filled) and all(c.startswith("**") and c.endswith("**") for c in filled)


def _split_table(block: str, limit: int) -> list[str]:
    """Split a long markdown table on row boundaries, repeating its labels in every piece.

    Without this, a continuation piece is rows of dates with no column names: the
    Summer calendar's "Last Day to Drop | May 18 | May 18 | June 30" doesn't say which
    date is Summer A. Each later piece starts with the table's header (when it has
    text) and the latest run of bold label rows, such as "Summer Full Term | Summer A |
    Summer B" and the session date ranges under it.
    """
    rows = block.splitlines()
    header = rows[:2] if len(rows) > 1 and _TABLE_SEPARATOR_RE.match(rows[1]) and any(_cells(rows[0])) else []
    pieces: list[str] = []
    current: list[str] = []
    context = 0  # how many leading lines of `current` are repeated labels
    labels: list[str] = []
    in_run = False
    for row in rows:
        if len(current) > context and len("\n".join(current)) + len(row) + 1 > limit:
            pieces.append("\n".join(current))
            current = [*header, *labels]
            context = len(current)
        current.append(row)
        if _is_label_row(row):
            labels = ([*labels, row] if in_run else [row])[-2:]
        in_run = _is_label_row(row)
    if len(current) > context or not pieces:
        pieces.append("\n".join(current))
    # A single row longer than the limit still gets hard-wrapped.
    return [p for piece in pieces for p in (_split_long(piece, limit) if len(piece) > limit else [piece])]


def chunk_page(text: str, limit: int = CHUNK_CHARS) -> list[tuple[str, str]]:
    """Split a page into (section, text) chunks that respect headings and paragraphs."""
    trail: list[str] = []
    sections: list[tuple[str, list[str]]] = [("", [])]
    for line in text.splitlines():
        heading = _HEADING_RE.match(line)
        if heading:
            level = len(heading.group(1))
            trail = trail[: level - 1] + [heading.group(2).strip("*_ ")]
            sections.append((" > ".join(t for t in trail if t), [line]))
        else:
            sections[-1][1].append(line)

    chunks: list[tuple[str, str]] = []
    for section, lines in sections:
        blocks = [b.strip() for b in re.split(r"\n\s*\n", "\n".join(lines)) if b.strip()]
        current = ""
        for block in blocks:
            if len(block) <= limit:
                split = [block]
            elif all(line.lstrip().startswith("|") for line in block.splitlines()):
                split = _split_table(block, limit)
            else:
                split = _split_long(block, limit)
            for piece in split:
                if current and len(current) + len(piece) + 2 > limit:
                    chunks.append((section, current))
                    current = piece
                else:
                    current = f"{current}\n\n{piece}" if current else piece
        if current:
            chunks.append((section, current))
    return chunks


def fts_query(query: str) -> str | None:
    """OR together the query's terms, plus adjacent pairs as phrases.

    BM25 rewards pages that match more (and rarer) terms, so OR keeps recall
    high without letting one common word dominate. Pairs like "ENC 1101" or
    "fall 2026" score extra when they appear together.
    """
    tokens = [t.lower() for t in _TOKEN_RE.findall(query)]
    terms = [t for t in tokens if t not in _STOPWORDS and len(t) > 1]
    if not terms:
        terms = [t for t in tokens if len(t) > 1]
    if not terms:
        return None
    parts = [f'"{t}"' for t in dict.fromkeys(terms)]
    parts += [f'"{a} {b}"' for a, b in dict.fromkeys(zip(terms, terms[1:]))]
    return " OR ".join(parts)


class SearchIndex:
    def __init__(self, pages: list[Page], checked: str = ""):
        self.pages = pages
        self.checked = checked
        self._by_url = {normalize_url(page.url): i for i, page in enumerate(pages)}
        self._chunks: list[Chunk] = []
        self._lock = threading.Lock()
        self._db = sqlite3.connect(":memory:", check_same_thread=False)
        self._db.execute(
            "CREATE VIRTUAL TABLE chunks USING fts5("
            "title, section, body, chunk_id UNINDEXED, "
            "tokenize='porter unicode61 remove_diacritics 2')"
        )
        rows = []
        for page_id, page in enumerate(pages):
            for section, text in chunk_page(page.text):
                chunk_id = len(self._chunks)
                self._chunks.append(Chunk(page_id, section, text))
                rows.append((page.title, section, text, chunk_id))
        self._db.executemany(
            "INSERT INTO chunks (title, section, body, chunk_id) VALUES (?, ?, ?, ?)",
            rows,
        )
        self._db.commit()

    def search(self, query: str, limit: int = 8) -> list[dict]:
        match = fts_query(query)
        if match is None:
            return []
        limit = max(1, min(int(limit), MAX_RESULTS))
        with self._lock:
            rows = self._db.execute(
                "SELECT chunk_id FROM chunks WHERE chunks MATCH ? "
                f"ORDER BY bm25(chunks, {', '.join(map(str, _WEIGHTS))}) LIMIT 400",
                (match,),
            ).fetchall()
        results: list[dict] = []
        seen: set[int] = set()
        for (chunk_id,) in rows:
            chunk = self._chunks[chunk_id]
            if chunk.page in seen:
                continue
            seen.add(chunk.page)
            results.append(self._result(chunk_id))
            if len(results) == limit:
                break
        return results

    def _result(self, chunk_id: int) -> dict:
        chunk = self._chunks[chunk_id]
        page = self.pages[chunk.page]
        excerpt = chunk.text
        # Short chunks (a heading and one line) read better with what follows.
        next_id = chunk_id + 1
        while (
            len(excerpt) < EXCERPT_CHARS // 2
            and next_id < len(self._chunks)
            and self._chunks[next_id].page == chunk.page
        ):
            excerpt = f"{excerpt}\n\n{self._chunks[next_id].text}"
            next_id += 1
        result = {"title": page.title, "url": page.url, "updated": page.updated}
        if chunk.section:
            result["section"] = chunk.section
        result["excerpt"] = excerpt[:EXCERPT_CHARS]
        return result

    def page(self, url: str) -> Page | None:
        page_id = self._by_url.get(normalize_url(url))
        return None if page_id is None else self.pages[page_id]

    def read(self, url: str, start: int = 0) -> dict | None:
        page = self.page(url)
        if page is None:
            return None
        start = max(0, int(start))
        end = start + READ_CHARS
        return {
            "title": page.title,
            "url": page.url,
            "updated": page.updated,
            "text": page.text[start:end],
            "start": start,
            "next_start": end if end < len(page.text) else None,
            "length": len(page.text),
        }


@lru_cache(maxsize=1)
def default_index() -> SearchIndex:
    return SearchIndex(load_pages(CORPUS_DIR), read_checked(CORPUS_DIR))
