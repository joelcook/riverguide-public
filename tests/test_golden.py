import re
import unittest
from pathlib import Path

import yaml

from riverguide.corpus import normalize_url
from riverguide.index import default_index

REPO_ROOT = Path(__file__).resolve().parent.parent
GOLDEN = yaml.safe_load((REPO_ROOT / "evals" / "golden.yaml").read_text(encoding="utf-8"))
ALLOWED_KEYS = {
    "id", "question", "category", "must_ground", "must_call_tool", "must_not_call_tool",
    "must_contain", "must_not_contain", "must_cite_url", "expected_summary", "notes",
}
TOOLS = {"search", "read_page", "search_sections"}


class GoldenSetTests(unittest.TestCase):
    def test_shape(self):
        self.assertEqual(len(GOLDEN), 53)
        self.assertEqual(len({item["id"] for item in GOLDEN}), 53)
        for item in GOLDEN:
            with self.subTest(item=item["id"]):
                self.assertLessEqual(set(item), ALLOWED_KEYS)
                self.assertIn(item["category"], {"hard_fact", "narrative", "out_of_scope", "contradiction"})
                self.assertIn(item.get("must_call_tool", "search_sections"), TOOLS)
                self.assertIn(item.get("must_not_call_tool", "any"), TOOLS | {"any"})

    def test_every_answerable_item_checks_something(self):
        for item in GOLDEN:
            if item["category"] != "out_of_scope":
                self.assertTrue(item.get("must_ground") or item.get("must_call_tool"), item["id"])

    def test_canonical_urls_are_in_the_corpus(self):
        index = default_index()
        for item in GOLDEN:
            for url in item.get("must_cite_url", []):
                self.assertIsNotNone(index.page(url), f"{item['id']}: {url}")


class PromptTests(unittest.TestCase):
    prompt = (REPO_ROOT / "prompt.md").read_text(encoding="utf-8")

    def test_names_only_real_tools(self):
        named = set(re.findall(r"\b(search_sections|read_page|search_wiki|get_\w+|list_\w+)\b", self.prompt))
        self.assertLessEqual(named, TOOLS)

    def test_stays_short(self):
        self.assertLess(len(self.prompt.split()), 1000, "the point of v2 is a short prompt")


if __name__ == "__main__":
    unittest.main()
