import unittest

from riverguide.corpus import Page
from riverguide.index import CHUNK_CHARS, SearchIndex, chunk_page, default_index, fts_query

PAGES = [
    Page("https://irsc.edu/calendar", "Catalog > Academic Calendar > Fall 2026", "2026-09-02",
         "# Fall 2026\n\n| Last day to Add or to Drop classes | Tuesday, August 25, 2026 |\n\n"
         "| Registration Deadline | Monday, August 10, 2026 |"),
    Page("https://irsc.edu/help-desk", "Student Help Desk", "2026-06-04",
         "# Student Help Desk\n\nPassword resets.\n\n## Contact\n\nStudentHelpDesk@irsc.edu\n\n772-462-7039"),
    Page("https://irsc.edu/library", "Library", "2026-06-04", "# Library\n\nBooks, study rooms, and research help."),
]


class ChunkTests(unittest.TestCase):
    def test_sections_follow_headings(self):
        chunks = chunk_page("# Title\n\nIntro\n\n## Part A\n\nAlpha\n\n### Detail\n\nBeta")
        self.assertEqual([s for s, _ in chunks], ["Title", "Title > Part A", "Title > Part A > Detail"])

    def test_split_tables_repeat_their_column_labels(self):
        # The Summer calendar's shape: an empty header row, then a bold row naming the sessions.
        rows = ["|  |  |  |  |", "| --- | --- | --- | --- |", "| Early registration | Feb 24 | | |"]
        rows += ["| **Summer Term 2027** | **Summer Full Term** | **Summer A** | **Summer B** |"]
        rows += [f"| Deadline {i} {'x' * 80} | May {i} | May {i} | June {i} |" for i in range(1, 40)]
        chunks = chunk_page("# Summer 2027\n\n" + "\n".join(rows))
        tables = [text for _, text in chunks if "Deadline" in text]
        self.assertGreater(len(tables), 2)
        for text in tables[1:]:
            self.assertTrue(text.startswith("| **Summer Term 2027** | **Summer Full Term** | **Summer A** |"), text[:80])
            self.assertLessEqual(len(text), CHUNK_CHARS)
        self.assertEqual(sum(text.count("| Deadline ") for text in tables), 39, "every row lands in exactly one chunk")

    def test_long_blocks_are_split_under_the_limit(self):
        table = "\n".join(f"| row {i} | {'x' * 60} |" for i in range(200))
        chunks = chunk_page(table)
        self.assertGreater(len(chunks), 5)
        self.assertTrue(all(len(text) <= CHUNK_CHARS for _, text in chunks))


class QueryTests(unittest.TestCase):
    def test_drops_stopwords_and_adds_phrase_pairs(self):
        self.assertEqual(fts_query("How many credits is ENC 1101?"), '"many" OR "credits" OR "enc" OR "1101" OR "many credits" OR "credits enc" OR "enc 1101"')

    def test_punctuation_cannot_break_fts_syntax(self):
        index = SearchIndex(PAGES)
        for query in ['"', "AND OR NOT", "drop*", "(fall)", "NEAR(a b)", "¿cuándo?"]:
            index.search(query)  # must not raise

    def test_empty_query(self):
        self.assertIsNone(fts_query("?? !!"))


class SearchTests(unittest.TestCase):
    def setUp(self):
        self.index = SearchIndex(PAGES, checked="2026-10-06")

    def test_ranks_the_page_that_answers(self):
        self.assertEqual(self.index.search("drop deadline fall 2026")[0]["url"], "https://irsc.edu/calendar")
        self.assertEqual(self.index.search("help desk phone")[0]["url"], "https://irsc.edu/help-desk")

    def test_result_shape_supports_copilot_citations(self):
        result = self.index.search("help desk")[0]
        self.assertEqual(set(result) - {"section"}, {"title", "url", "updated", "excerpt"})
        self.assertIn("772-462-7039", result["excerpt"])

    def test_one_result_per_page(self):
        urls = [r["url"] for r in self.index.search("library help research books")]
        self.assertEqual(len(urls), len(set(urls)))

    def test_read_pages_through_long_text(self):
        long_page = Page("https://irsc.edu/long", "Long", "2026-01-01", "x" * 40000)
        index = SearchIndex([long_page])
        first = index.read("http://www.irsc.edu/long/")
        self.assertEqual((first["start"], first["next_start"], first["length"]), (0, 15000, 40000))
        last = index.read("https://irsc.edu/long", start=30000)
        self.assertIsNone(last["next_start"])
        self.assertIsNone(index.read("https://irsc.edu/missing"))


class RealCorpusTests(unittest.TestCase):
    """Spot checks that the committed corpus answers common questions."""

    def top_urls(self, query, n=3):
        return [r["url"] for r in default_index().search(query, n)]

    def test_common_questions(self):
        cases = {
            "drop deadline fall 2026": "academic-calendar/fall-2026",
            "ENC 1101": "enc-english/1000/enc-1101",
            "student help desk": "irsc.libguides.com/StudentHelpDesk",
            "Florida residency requirements": "residency",
            "Promise program": "promise",
            "commercial vehicle driving CDL": "commercial-vehicle-driving",
        }
        for query, fragment in cases.items():
            with self.subTest(query=query):
                self.assertTrue(any(fragment in url for url in self.top_urls(query)), self.top_urls(query))


if __name__ == "__main__":
    unittest.main()
