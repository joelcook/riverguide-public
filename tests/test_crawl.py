import unittest
from pathlib import Path

from riverguide.crawl import catalog_links, extract, page_title

FIXTURE = (Path(__file__).parent / "fixtures" / "catalog_page.html").read_text(encoding="utf-8")
URL = "https://irsc.smartcatalogiq.com/en/current/catalog/courses/enc-english/1000/enc-1101"


class ExtractTests(unittest.TestCase):
    def test_keeps_main_content_inside_aspnet_form(self):
        title, text = extract(URL, FIXTURE)
        self.assertEqual(title, "Catalog > Courses > Enc English > ENC 1101 English Composition I")
        self.assertTrue(text.startswith("# ENC 1101 English Composition I"))
        self.assertIn("3 credits", text)

    def test_strips_chrome_and_scripts(self):
        _, text = extract(URL, FIXTURE)
        for noise in ("Skip to main content", "Copyright", "trackPageView"):
            self.assertNotIn(noise, text)

    def test_links_become_absolute(self):
        _, text = extract(URL, FIXTURE)
        self.assertIn("(https://irsc.smartcatalogiq.com/en/current/catalog/courses/enc-english/0000/enc-0017)", text)

    def test_catalog_links_stay_in_the_catalog(self):
        links = catalog_links(FIXTURE)
        self.assertIn("https://irsc.smartcatalogiq.com/en/current/catalog/courses", links)
        self.assertTrue(all(link.startswith("https://irsc.smartcatalogiq.com/en/current/catalog") for link in links))

    def test_rowspan_keeps_columns_aligned(self):
        # The Summer 2027 calendar: "Summer Term 2027" spans two rows, so the date row has three cells.
        html = """<main><table>
          <tr><td rowspan="2">Summer Term 2027</td><td>Summer Full Term</td><td>Summer A</td><td>Summer B</td></tr>
          <tr><td>May 12 - Aug 3</td><td>May 12 - June 21</td><td>June 24 - Aug 3</td></tr>
          <tr><td colspan="2">College Closed</td><td>May 31</td><td>July 5</td></tr>
        </table></main>"""
        _, text = extract("https://irsc.edu/x", html)
        rows = [[c.strip() for c in line.strip().strip("|").split("|")] for line in text.splitlines() if line.startswith("|")]
        header, dates, closed = rows[-3:]  # after the empty header row markdownify adds
        self.assertEqual(header[2], "Summer A")
        self.assertEqual(dates[2], "May 12 - June 21")
        self.assertEqual(closed, ["College Closed", "", "May 31", "July 5"])

    def test_site_titles(self):
        self.assertEqual(
            page_title("https://irsc.edu/admissions/tuition-fees/residency-requirements", "Florida Residency"),
            "Admissions > Tuition Fees > Florida Residency",
        )


if __name__ == "__main__":
    unittest.main()
