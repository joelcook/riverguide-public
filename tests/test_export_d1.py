import io
import re
import sqlite3
import unittest
from pathlib import Path

from riverguide.export_d1 import write_sql
from riverguide.index import default_index, fts_query
from riverguide.sections import DB_PATH as SECTIONS_DB

WORKER_SEARCH = (Path(__file__).resolve().parent.parent / "web" / "src" / "search.ts").read_text(encoding="utf-8")


class ExportTests(unittest.TestCase):
    """The Worker must rank exactly like riverguide/index.py: load the D1 export into
    SQLite and run the Worker's own search SQL against it."""

    @classmethod
    def setUpClass(cls):
        sql = io.StringIO()
        cls.meta = write_sql(sql)
        cls.db = sqlite3.connect(":memory:")
        cls.db.executescript(sql.getvalue())
        query = re.search(r"\.prepare\(\s*`(WITH hits AS.*?)`", WORKER_SEARCH, re.DOTALL).group(1)
        cls.search_sql = query.replace("?1", ":match").replace("?2", ":limit")

    def worker_search(self, query, limit=8):
        rows = self.db.execute(self.search_sql, {"match": fts_query(query), "limit": limit}).fetchall()
        return [url for _, url, *_ in rows]

    def test_everything_loaded_and_swapped_in(self):
        index = default_index()
        tables = {r[0] for r in self.db.execute("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")}
        self.assertFalse({t for t in tables if t.endswith("_next")}, "staging tables left behind")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM pages").fetchone()[0], len(index.pages))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM chunks").fetchone()[0], len(index._chunks))
        with sqlite3.connect(f"file:{SECTIONS_DB}?mode=ro", uri=True) as source:
            (sections,) = source.execute("SELECT COUNT(*) FROM course_sections").fetchone()
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM course_sections").fetchone()[0], sections)

    def test_pages_reassemble_exactly(self):
        index = default_index()
        page = max(index.pages, key=lambda p: len(p.text))
        (page_id,) = self.db.execute("SELECT id FROM pages WHERE url = ?", (page.url,)).fetchone()
        parts = self.db.execute("SELECT text FROM page_text WHERE page_id = ? ORDER BY seq", (page_id,)).fetchall()
        self.assertGreater(len(parts), 1)
        self.assertEqual("".join(p for (p,) in parts), page.text)

    def test_worker_ranks_like_python(self):
        index = default_index()
        for query in (
            "drop deadline fall 2026", "ENC 1101", "student help desk", "Florida residency requirements",
            "Promise program", "commercial vehicle driving CDL", "How much is tuition per credit hour?",
            "nursing program prerequisites", "¿cuándo es la fecha límite?",
        ):
            with self.subTest(query=query):
                self.assertEqual(self.worker_search(query), [r["url"] for r in index.search(query, 8)])

    def test_statements_fit_d1_limits(self):
        sql = io.StringIO()
        write_sql(sql)
        longest = max(len(s.encode()) for s in sql.getvalue().split(";\n"))
        self.assertLess(longest, 100_000)


if __name__ == "__main__":
    unittest.main()
