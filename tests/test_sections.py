import sqlite3
import unittest

from riverguide.sections import DB_PATH, search_sections

PUBLIC_SECTION_FIELDS = {
    "crn", "course_code", "section", "title", "part_of_term", "delivery", "campus", "start_date_text",
    "end_date_text", "meeting_schedule", "location_summary", "schedule_type", "seat_status",
}


def _has_snapshot() -> bool:
    with sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True) as conn:
        return conn.execute("SELECT COUNT(*) FROM course_sections").fetchone()[0] > 0


# The public repository ships data/sections.db with the schema and no rows.
needs_snapshot = unittest.skipUnless(_has_snapshot(), "data/sections.db has no snapshot rows")


class SectionTests(unittest.TestCase):
    @needs_snapshot
    def test_offered_online(self):
        result = search_sections("Fall 2026", course_code="enc1101", delivery="online")
        self.assertTrue(result["coverage"]["covered"])
        self.assertGreater(result["match_count"], 0)
        self.assertTrue(all(s["course_code"] == "ENC 1101" for s in result["sections"]))
        self.assertEqual(set(result["sections"][0]), PUBLIC_SECTION_FIELDS)
        self.assertFalse(result["freshness"]["real_time"])

    @needs_snapshot
    def test_zero_matches_is_not_proof_of_absence(self):
        result = search_sections("fall-2026", course_code="ZZZ 9999", delivery="online")
        self.assertEqual(result["match_count"], 0)
        self.assertIn("does not mean the course is never offered", result["message"])

    def test_uncovered_term(self):
        result = search_sections("Spring 1999")
        self.assertFalse(result["coverage"]["covered"])
        self.assertEqual(result["sections"], [])

    def test_ambiguous_campus_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "Fort Pierce"):
            search_sections("Fall 2026", campus="Fort Pierce")

    def test_campus_aliases(self):
        result = search_sections("Fall 2026", course_code="ENC 1101", campus="Pruitt campus")
        self.assertEqual(result["filters"]["campus"], "PRU")

    @needs_snapshot
    def test_result_carries_citation_fields(self):
        result = search_sections("Fall 2026", course_code="ENC 1101")
        self.assertTrue(result["url"].startswith("https://"))
        self.assertIn("Fall 2026", result["title"])


class DataContractTests(unittest.TestCase):
    def test_database_holds_only_allowlisted_tables_and_columns(self):
        with sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True) as conn:
            tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            self.assertEqual(tables, {"terms", "course_section_snapshots", "course_sections"})
            columns = {r[1] for r in conn.execute("PRAGMA table_info(course_sections)")}
            for forbidden in ("instructor", "enrollment", "capacity", "seats_remaining", "student_id"):
                self.assertFalse(any(forbidden in c for c in columns), forbidden)
            statuses = {r[0] for r in conn.execute("SELECT DISTINCT seat_status FROM course_sections")}
            self.assertLessEqual(statuses, {"reported_open", "reported_full"})


if __name__ == "__main__":
    unittest.main()
