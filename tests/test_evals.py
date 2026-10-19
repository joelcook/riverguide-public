import json
import unittest
from pathlib import Path
from types import SimpleNamespace as NS

from evals import run

LEGACY = Path(__file__).resolve().parents[2] / "irsc-knowledge-base"


def usage(n_in=100, n_out=10):
    return NS(input_tokens=n_in, output_tokens=n_out, cache_creation_input_tokens=0, cache_read_input_tokens=0)


def reply(*blocks, stop="end_turn"):
    return NS(content=list(blocks), stop_reason=stop, usage=usage(), model="claude-opus-5-5", stop_details=None)


class FakeClient:
    """Returns scripted responses and records each request."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests = []
        self.beta = NS(messages=NS(create=self.create))

    def create(self, **kwargs):
        self.requests.append(json.loads(json.dumps(kwargs, default=lambda o: vars(o))))
        return self.responses.pop(0)


class GradingTests(unittest.TestCase):
    def test_linked_urls(self):
        text = "See [the calendar](https://www.irsc.edu/calendar/) or https://irsc.edu/faq."
        self.assertEqual(run.linked_urls(text), {"https://irsc.edu/calendar", "https://irsc.edu/faq"})

    def test_grade_v2(self):
        item = {"must_ground": True, "must_contain": ["August 25"], "must_not_contain": ["August 10"],
                "must_cite_url": ["https://irsc.edu/calendar"]}
        good = {"response": "It's August 25. [Calendar](https://irsc.edu/calendar)", "tool_calls": [{"name": "search"}]}
        self.assertEqual(run.grade_v2(item, good), [])
        bad = {"response": "It's August 10.", "tool_calls": []}
        reasons = run.grade_v2(item, bad)
        self.assertEqual(len(reasons), 4, reasons)

    def test_out_of_scope_must_not_search(self):
        item = {"must_not_call_tool": "any", "must_contain": ["River Portal"]}
        result = {"response": "Check The River Portal.", "tool_calls": [{"name": "search"}]}
        self.assertEqual(run.grade_v2(item, result), ["expected no tool calls, called: ['search']"])


class AgentLoopTests(unittest.TestCase):
    def setUp(self):
        self.system = run.System(
            name="test", prompt="Be helpful.", tools=[{"name": "search", "description": "d", "input_schema": {"type": "object"}}],
            dispatch=lambda name, args: {"results": [{"url": "https://irsc.edu/calendar", "q": args["query"]}]},
            golden=Path("unused"), grade=run.grade_v2,
        )

    def test_runs_tools_then_answers(self):
        client = FakeClient(
            reply(NS(type="thinking", thinking=""), NS(type="tool_use", id="t1", name="search", input={"query": "drop"}), stop="tool_use"),
            reply(NS(type="text", text="August 25. [Calendar](https://irsc.edu/calendar)")),
        )
        result = run.run_agent(client, self.system, "When is drop?", "claude-opus-5-5", "medium", 8)
        self.assertEqual(result["response"], "August 25. [Calendar](https://irsc.edu/calendar)")
        self.assertEqual([c["name"] for c in result["tool_calls"]], ["search"])
        self.assertEqual(result["usage"]["input"], 200)
        second = client.requests[1]["messages"]
        self.assertEqual(second[1]["role"], "assistant")  # assistant turn appended unchanged
        self.assertEqual(second[1]["content"][0]["type"], "thinking")
        self.assertEqual(second[2]["content"][0]["tool_use_id"], "t1")
        self.assertIn('"q": "drop"', second[2]["content"][0]["content"])
        self.assertEqual(client.requests[0]["fallbacks"], "default")

    def test_refusal_is_an_error_not_an_answer(self):
        refused = reply(stop="refusal")
        refused.stop_details = NS(category="cyber")
        result = run.run_agent(FakeClient(refused), self.system, "q", "m", "medium", 8)
        self.assertEqual((result["response"], result["error"]), ("", "refusal (cyber)"))

    def test_loop_cap(self):
        calls = [reply(NS(type="tool_use", id=f"t{i}", name="search", input={"query": "x"}), stop="tool_use") for i in range(3)]
        result = run.run_agent(FakeClient(*calls), self.system, "q", "m", "medium", 3)
        self.assertEqual(result["error"], "tool loop cap reached")


class SystemTests(unittest.TestCase):
    def test_v2_tools_match_the_server(self):
        system = run.v2_system()
        self.assertEqual(sorted(t["name"] for t in system.tools), ["read_page", "search", "search_sections"])
        self.assertIn("results", system.dispatch("search", {"query": "help desk"}))
        self.assertIn("error", system.dispatch("search_sections", {"term": "Fall 2026", "campus": "Fort Pierce"}))

    @unittest.skipUnless((LEGACY / "irsc_kb").exists(), "RiverGuide 1 checkout not found next to this repo")
    def test_legacy_system_loads_with_its_own_tools_and_graders(self):
        system = run.legacy_system(LEGACY)
        self.assertEqual(len(system.tools), 12)
        self.assertIn("get_deadline", [t["name"] for t in system.tools])
        item = {"category": "hard_fact", "must_call_tool": "get_deadline", "must_contain": ["August 25"]}
        self.assertEqual(system.grade(item, {"response": "August 25", "tool_calls": [{"name": "get_deadline", "input": {}}]}), [])
        self.assertTrue(system.grade(item, {"response": "August 25", "tool_calls": []}))
        self.assertIsInstance(system.dispatch("list_terms", {}), list)


if __name__ == "__main__":
    unittest.main()
