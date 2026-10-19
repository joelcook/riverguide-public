"""Write corpus/ and the course-section snapshot as SQL for Cloudflare D1.

    .venv/bin/python -m riverguide.export_d1 > web/.build/d1.sql
    npx wrangler d1 execute riverguide --local --file web/.build/d1.sql     # or --remote

The Worker runs the same search as riverguide/index.py: the chunks, excerpts,
and FTS5 settings come from SearchIndex, so there is one definition of how a
page is split and what a result shows. Everything loads into *_next tables and
is swapped in by renames at the end, so a reload never leaves search empty.
The feedback table is never touched.
"""
from __future__ import annotations

import re
import sqlite3
import sys
from pathlib import Path
from typing import Iterable, TextIO

from riverguide.corpus import normalize_url
from riverguide.index import default_index
from riverguide.sections import DB_PATH as SECTIONS_DB

PAGE_PART_CHARS = 30_000  # D1 caps one statement at 100 KB
ROWS_PER_INSERT = 20
MAX_STATEMENT_BYTES = 90_000

SCHEMA = """
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY,
  created TEXT NOT NULL,
  rating TEXT NOT NULL CHECK (rating IN ('up', 'down')),
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  sources TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL
);
DROP TABLE IF EXISTS meta_next;
DROP TABLE IF EXISTS pages_next;
DROP TABLE IF EXISTS page_text_next;
DROP TABLE IF EXISTS chunks_next;
CREATE TABLE meta_next (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE pages_next (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  url_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  updated TEXT NOT NULL,
  length INTEGER NOT NULL
);
CREATE TABLE page_text_next (page_id INTEGER NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (page_id, seq));
CREATE VIRTUAL TABLE chunks_next USING fts5(
  title, section, body, page_id UNINDEXED, excerpt UNINDEXED,
  tokenize='porter unicode61 remove_diacritics 2'
);
"""

SECTION_TABLES = ("terms", "course_section_snapshots", "course_sections")
SWAPPED = ("meta", "pages", "page_text", "chunks", *SECTION_TABLES)


def quote(value: object) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return repr(value)
    return "'" + str(value).replace("'", "''") + "'"


def inserts(table: str, columns: Iterable[str], rows: Iterable[tuple]) -> Iterable[str]:
    """Multi-row INSERTs that stay under D1's statement size limit."""
    head = f"INSERT INTO {table} ({', '.join(columns)}) VALUES "
    batch: list[str] = []
    size = len(head)
    for row in rows:
        values = "(" + ", ".join(quote(v) for v in row) + ")"
        if batch and (len(batch) == ROWS_PER_INSERT or size + len(values.encode()) > MAX_STATEMENT_BYTES):
            yield head + ", ".join(batch) + ";"
            batch, size = [], len(head)
        batch.append(values)
        size += len(values.encode()) + 2
    if batch:
        yield head + ", ".join(batch) + ";"


def section_statements() -> Iterable[str]:
    with sqlite3.connect(f"file:{SECTIONS_DB}?mode=ro", uri=True) as conn:
        for table in SECTION_TABLES:
            (schema,) = conn.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone()
            yield f"DROP TABLE IF EXISTS {table}_next;"
            # Foreign keys would point the *_next tables at the live ones (D1 enforces them),
            # and a read-only snapshot gains nothing from them.
            schema = re.sub(r"\s+REFERENCES\s+\w+\s*\(\w+\)", "", schema)
            yield re.sub(rf'^CREATE TABLE "?{table}"?', f"CREATE TABLE {table}_next", schema) + ";"
            cursor = conn.execute(f"SELECT * FROM {table}")
            columns = [d[0] for d in cursor.description]
            yield from inserts(f"{table}_next", columns, cursor)


def write_sql(out: TextIO) -> dict:
    index = default_index()
    out.write(SCHEMA)
    meta = {"checked": index.checked, "pages": str(len(index.pages)), "chunks": str(len(index._chunks))}
    for statement in inserts("meta_next", ("key", "value"), meta.items()):
        out.write(statement + "\n")

    pages = []
    texts = []
    for page_id, page in enumerate(index.pages):
        pages.append((page_id, page.url, normalize_url(page.url), page.title, page.updated, len(page.text)))
        for seq, start in enumerate(range(0, max(len(page.text), 1), PAGE_PART_CHARS)):
            texts.append((page_id, seq, page.text[start:start + PAGE_PART_CHARS]))
    for statement in inserts("pages_next", ("id", "url", "url_key", "title", "updated", "length"), pages):
        out.write(statement + "\n")
    for statement in inserts("page_text_next", ("page_id", "seq", "text"), texts):
        out.write(statement + "\n")

    chunks = (
        (chunk_id, index.pages[c.page].title, c.section, c.text, c.page, index._result(chunk_id)["excerpt"])
        for chunk_id, c in enumerate(index._chunks)
    )
    for statement in inserts("chunks_next", ("rowid", "title", "section", "body", "page_id", "excerpt"), chunks):
        out.write(statement + "\n")

    for statement in section_statements():
        out.write(statement + "\n")

    # Swap: each DROP/RENAME pair runs back to back, so search is never empty for long.
    for table in SWAPPED:
        out.write(f"DROP TABLE IF EXISTS {table};\nALTER TABLE {table}_next RENAME TO {table};\n")
    return meta


def main() -> int:
    meta = write_sql(sys.stdout)
    print(f"d1 export: {meta['pages']} pages, {meta['chunks']} chunks, checked {meta['checked']}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
