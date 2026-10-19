import asyncio
import unittest

from riverguide import server


class ToolSurfaceTests(unittest.TestCase):
    def test_exactly_three_read_only_tools(self):
        tools = asyncio.run(server.mcp.list_tools())
        self.assertEqual(sorted(t.name for t in tools), ["read_page", "search", "search_sections"])
        for tool in tools:
            self.assertTrue(tool.annotations.readOnlyHint, tool.name)
            self.assertGreater(len(tool.description or ""), 100, f"{tool.name} needs a real description")

    def test_search_returns_citable_results(self):
        result = server.search("student help desk")
        self.assertRegex(result["checked"], r"^\d{4}-\d{2}-\d{2}$")
        self.assertTrue(all(r["url"].startswith("https://") and r["title"] for r in result["results"]))

    def test_search_with_no_matches_says_what_to_do(self):
        result = server.search("qqqzzzxx")
        self.assertEqual(result["results"], [])
        self.assertIn("Try different words", result["note"])

    def test_read_page_rejects_urls_outside_the_index(self):
        self.assertIn("error", server.read_page("https://example.com/"))
        self.assertIn("text", server.read_page("https://irsc.edu/contact-us"))


class AuthTests(unittest.TestCase):
    def test_failure_reasons(self):
        expected = b"secret"
        cases = {
            None: "missing_authorization_header",
            b"secret": "malformed_authorization_header",
            b"Basic secret": "unsupported_authorization_scheme",
            b"Bearer ": "missing_bearer_token",
            b"Bearer wrong": "invalid_bearer_token",
            b"Bearer secret": None,
            b"bearer secret": None,
        }
        for header, reason in cases.items():
            with self.subTest(header=header):
                self.assertEqual(server.auth_failure(header, expected), reason)

    def test_middleware_rejects_unauthenticated_requests(self):
        calls = []

        async def app(scope, receive, send):
            calls.append(scope["path"])

        sent = []

        async def send(message):
            sent.append(message)

        middleware = server.BearerAuth(app, "secret")
        scope = {"type": "http", "method": "POST", "path": "/mcp", "headers": []}
        asyncio.run(middleware(scope, None, send))
        self.assertEqual(calls, [])
        self.assertEqual(sent[0]["status"], 401)
        asyncio.run(middleware({**scope, "headers": [(b"authorization", b"Bearer secret")]}, None, send))
        self.assertEqual(calls, ["/mcp"])


if __name__ == "__main__":
    unittest.main()
