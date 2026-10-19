import tempfile
import unittest
from pathlib import Path

from riverguide.corpus import (
    CORPUS_DIR,
    Page,
    load_pages,
    normalize_url,
    parse_page,
    path_for_url,
    read_checked,
    render_page,
    write_page,
)


class UrlTests(unittest.TestCase):
    def test_normalize_drops_scheme_www_fragment_and_trailing_slash(self):
        self.assertEqual(normalize_url("http://www.irsc.edu/admissions/#apply"), "https://irsc.edu/admissions")
        self.assertEqual(normalize_url("https://irsc.edu/"), "https://irsc.edu")

    def test_path_mirrors_url(self):
        self.assertEqual(path_for_url("https://irsc.edu/admissions/apply"), Path("irsc.edu/admissions/apply.md"))
        self.assertEqual(path_for_url("https://irsc.edu/"), Path("irsc.edu/index.md"))

    def test_path_keeps_query_and_rejects_traversal(self):
        path = path_for_url("https://irsc.libguides.com/c.php?g=1423899&p=11480614")
        self.assertEqual(path, Path("irsc.libguides.com/c.php--g-1423899-p-11480614.md"))
        self.assertNotIn("..", path_for_url("https://irsc.edu/../../etc/passwd").parts)


class FileTests(unittest.TestCase):
    def test_round_trip(self):
        page = Page(url="https://irsc.edu/a", title="A: B", updated="2026-10-01", text="# A\n\nBody")
        self.assertEqual(parse_page(render_page(page)), page)

    def test_write_only_when_content_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            corpus = Path(tmp)
            page = Page(url="https://irsc.edu/a", title="A", updated="2026-10-01", text="Body")
            self.assertTrue(write_page(page, corpus))
            later = Page(url=page.url, title="A", updated="2026-10-02", text="Body")
            self.assertFalse(write_page(later, corpus), "unchanged content must not touch the file")
            self.assertEqual(load_pages(corpus)[0].updated, "2026-10-01")
            self.assertTrue(write_page(Page(url=page.url, title="A", updated="2026-10-03", text="New"), corpus))


class CommittedCorpusTests(unittest.TestCase):
    def test_every_file_parses_and_lives_at_its_url_path(self):
        pages = load_pages()
        self.assertGreater(len(pages), 2000)
        for path in CORPUS_DIR.rglob("*.md"):
            page = parse_page(path.read_text(encoding="utf-8"))
            self.assertIsNotNone(page, path)
            self.assertEqual(path.relative_to(CORPUS_DIR), path_for_url(page.url))

    def test_only_official_hosts(self):
        hosts = {normalize_url(p.url).split("/")[2] for p in load_pages()}
        allowed = {"irsc.edu", "apply.irsc.edu", "irsc.smartcatalogiq.com", "irsc.libguides.com"}
        self.assertLessEqual(hosts, allowed)

    def test_checked_date_is_recorded(self):
        self.assertRegex(read_checked(), r"^\d{4}-\d{2}-\d{2}$")


if __name__ == "__main__":
    unittest.main()
