"""Run the golden set against RiverGuide 2.0, or against RiverGuide 1 for comparison.

    .venv/bin/python -m evals.run --tier retrieval        # free: does one search surface the evidence?
    .venv/bin/python -m evals.run --tier full --judge     # Claude answers with the real tools, then grading
    .venv/bin/python -m evals.run --tier full --judge --system legacy --legacy ../irsc-knowledge-base
    .venv/bin/python -m evals.run --tier full --only drop-deadline-fall-2026
    .venv/bin/python -m evals.run --tier full --system api --endpoint http://127.0.0.1:8787   # the real product

Both systems run through the same agent loop (model, effort, caching, refusal
fallback); only the prompt and tools differ. Grading:

    passed         the system's own checks. v2: evals/golden.yaml (grounding,
                   canonical links, text). legacy: RiverGuide 1's own graders.
    answer_passed  the same for both: must_contain / must_not_contain, plus the
                   judge's verdict against expected_summary when --judge is on.

--system api sends each question to RiverGuide 2.0's own /api/chat (prompt, tools, model,
cache bypassed), so it grades exactly what students get; no API key is needed unless --judge.
The full tier otherwise calls the Anthropic API (ANTHROPIC_API_KEY, or a .env line) and
costs money; the summary prints the estimated cost. Production answers come from
the model selected in Copilot Studio, so treat this as a proxy, as v1 did.
"""
from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import hashlib
import json
import os
import re
import sys
import time
import warnings
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from riverguide.corpus import normalize_url  # noqa: E402

# The MCP SDK's settings model warns at import on Python 3.14; it is harmless here.
warnings.filterwarnings("ignore", message="Field 'lifespan'")

GOLDEN_PATH = REPO_ROOT / "evals" / "golden.yaml"
RUNS_DIR = REPO_ROOT / "evals" / "runs"
DEFAULT_MODEL = "claude-opus-5-5"
# claude-opus-5-5 list prices, USD per million tokens.
PRICE = {"input": 4.00, "cache_write": 5.00, "cache_read": 0.20, "output": 20.00}
GROUNDING_TOOLS = {"search", "read_page", "search_sections"}

JUDGE_PROMPT = """You are a strict grader for an Indian River State College student-chatbot eval set.

You will be given a student question, the expected answer summary (the rubric), and the chatbot's actual response.

Decide whether the response satisfies the rubric:
- Does it answer the question the student actually asked?
- Does it cover the substantive points in the rubric (not necessarily the exact wording)?
- Does it avoid fabricated or contradictory facts? The chatbot answers from official College sources you cannot see here, so do NOT treat plausible College-specific operational details (portal names, URLs, office phone numbers, step-by-step menu paths) as hallucinations merely because the rubric does not mention them. Flag a fact only if it contradicts the rubric or is clearly invented.
- Is it honest about uncertainty when appropriate?

Give a one-sentence reason and a pass/fail verdict."""

JUDGE_SCHEMA = {
    "type": "object",
    "properties": {"reason": {"type": "string"}, "pass": {"type": "boolean"}},
    "required": ["reason", "pass"],
    "additionalProperties": False,
}


@dataclass
class System:
    name: str
    prompt: str
    tools: list[dict]
    dispatch: Callable[[str, dict], Any]
    golden: Path
    grade: Callable[[dict, dict], list[str]]


# ---------- systems ----------


def v2_system() -> System:
    from riverguide import server

    async def list_tools():
        return await server.mcp.list_tools()

    tools = [
        {"name": t.name, "description": t.description or "", "input_schema": t.inputSchema}
        for t in asyncio.run(list_tools())
    ]
    functions = {"search": server.search, "read_page": server.read_page, "search_sections": server.search_sections}

    def dispatch(name: str, args: dict) -> Any:
        if name not in functions:
            return {"error": f"unknown tool {name!r}"}
        try:
            return functions[name](**args)
        except (TypeError, ValueError) as exc:
            return {"error": str(exc)}

    return System(
        name="v2",
        # Same as the Worker: prompt.md plus today's date (Eastern).
        prompt=(REPO_ROOT / "prompt.md").read_text(encoding="utf-8")
        + f"\n\nToday is {dt.datetime.now(ZoneInfo('America/New_York')):%A, %B %-d, %Y} (Eastern Time).",
        tools=tools,
        dispatch=dispatch,
        golden=GOLDEN_PATH,
        grade=grade_v2,
    )


def legacy_system(legacy_repo: Path) -> System:
    """RiverGuide 1 exactly as its own harness defines it: prompt, 12 tools, graders."""
    sys.path.insert(0, str(legacy_repo))
    from irsc_kb import evals as legacy  # type: ignore[import-not-found]

    graders = {
        "hard_fact": legacy.grade_hard_fact,
        "out_of_scope": legacy.grade_out_of_scope,
        "narrative": legacy.grade_narrative_fast,
        "contradiction": legacy.grade_contradiction,
    }

    def grade(item: dict, result: dict) -> list[str]:
        return list(graders[item["category"]](item, result)[1])

    return System(
        name="legacy",
        prompt=legacy.AGENT_SYSTEM_PROMPT,
        tools=legacy.TOOL_SCHEMAS,
        dispatch=legacy._dispatch_tool,
        golden=legacy_repo / "tests" / "evals" / "golden.yaml",
        grade=grade,
    )


# ---------- grading ----------

_LINK_RE = re.compile(r"\]\((https?://[^)\s]+)\)|(?<![(\[])(https?://[^\s<>)\]]+)")


def linked_urls(text: str) -> set[str]:
    urls = set()
    for match in _LINK_RE.finditer(text):
        url = (match.group(1) or match.group(2)).rstrip(".,;:'\"")
        urls.add(normalize_url(url))
    return urls


def text_reasons(item: dict, response: str) -> list[str]:
    lowered = response.lower()
    reasons = [f"missing {needle!r}" for needle in item.get("must_contain", []) if needle.lower() not in lowered]
    reasons += [f"contains {needle!r}" for needle in item.get("must_not_contain", []) if needle.lower() in lowered]
    return reasons


def grade_v2(item: dict, result: dict) -> list[str]:
    called = [call["name"] for call in result["tool_calls"]]
    reasons: list[str] = []
    if item.get("must_ground") and not GROUNDING_TOOLS & set(called):
        reasons.append("answered without searching")
    if item.get("must_call_tool") and item["must_call_tool"] not in called:
        reasons.append(f"{item['must_call_tool']} not called (called: {called or 'none'})")
    forbidden = item.get("must_not_call_tool")
    if forbidden == "any" and called:
        reasons.append(f"expected no tool calls, called: {called}")
    elif forbidden and forbidden != "any" and forbidden in called:
        reasons.append(f"called {forbidden}")
    reasons += text_reasons(item, result["response"])
    if item.get("must_cite_url"):
        expected = {normalize_url(u) for u in item["must_cite_url"]}
        linked = linked_urls(result["response"])
        if not expected & linked:
            reasons.append(f"no canonical link (linked: {sorted(linked)[:4] or 'none'})")
    return reasons


# ---------- model calls ----------


def load_api_key() -> None:
    if os.environ.get("ANTHROPIC_API_KEY"):
        return
    env = REPO_ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            key, _, value = line.partition("=")
            if key.strip() == "ANTHROPIC_API_KEY" and value.strip():
                os.environ["ANTHROPIC_API_KEY"] = value.strip().strip("'\"")


def add_usage(totals: Counter, usage: Any) -> None:
    totals["input"] += usage.input_tokens or 0
    totals["output"] += usage.output_tokens or 0
    totals["cache_write"] += getattr(usage, "cache_creation_input_tokens", 0) or 0
    totals["cache_read"] += getattr(usage, "cache_read_input_tokens", 0) or 0


def cost(totals: Counter) -> float:
    return sum(totals[k] * PRICE[k] for k in PRICE) / 1_000_000


def run_agent(client, system: System, question: str, model: str, effort: str, max_rounds: int) -> dict:
    messages: list[dict] = [{"role": "user", "content": question}]
    tool_calls: list[dict] = []
    usage: Counter = Counter()
    notes: list[str] = []
    for _ in range(max_rounds):
        response = client.beta.messages.create(
            model=model,
            max_tokens=16000,
            system=system.prompt,
            tools=system.tools,
            messages=messages,
            output_config={"effort": effort},
            cache_control={"type": "ephemeral"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
        add_usage(usage, response.usage)
        if any(block.type == "fallback" for block in response.content):
            notes.append(f"served by fallback model {response.model}")
        if response.stop_reason == "refusal":
            category = getattr(response.stop_details, "category", None)
            return {"response": "", "tool_calls": tool_calls, "usage": usage, "error": f"refusal ({category})", "notes": notes}
        tool_uses = [block for block in response.content if block.type == "tool_use"]
        if response.stop_reason != "tool_use" or not tool_uses:
            text = "".join(block.text for block in response.content if block.type == "text").strip()
            error = "hit max_tokens" if response.stop_reason == "max_tokens" else None
            return {"response": text, "tool_calls": tool_calls, "usage": usage, "error": error, "notes": notes}
        messages.append({"role": "assistant", "content": response.content})
        results = []
        for block in tool_uses:
            output = system.dispatch(block.name, dict(block.input))
            payload = json.dumps(output, default=str, ensure_ascii=False)
            tool_calls.append({"name": block.name, "input": dict(block.input), "result_chars": len(payload)})
            result = {"type": "tool_result", "tool_use_id": block.id, "content": payload}
            if isinstance(output, dict) and "error" in output:
                result["is_error"] = True
            results.append(result)
        messages.append({"role": "user", "content": results})
    return {"response": "", "tool_calls": tool_calls, "usage": usage, "error": "tool loop cap reached", "notes": notes}


def judge(client, model: str, item: dict, response: str, usage: Counter) -> dict:
    reply = client.messages.create(
        model=model,
        max_tokens=4000,
        system=JUDGE_PROMPT,
        messages=[
            {
                "role": "user",
                "content": (
                    f"## Student question\n{item['question']}\n\n"
                    f"## Expected summary (rubric)\n{item['expected_summary']}\n\n"
                    f"## Actual response\n{response}"
                ),
            }
        ],
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": JUDGE_SCHEMA}},
    )
    add_usage(usage, reply.usage)
    if reply.stop_reason == "refusal":
        return {"pass": False, "reason": "judge refused"}
    text = next((block.text for block in reply.content if block.type == "text"), "{}")
    return json.loads(text)


# ---------- the real endpoint ----------


def run_api(endpoint: str, question: str) -> dict:
    """Ask RiverGuide 2.0's /api/chat and read the UI message stream back."""
    import requests

    body = {"messages": [{"id": "eval", "role": "user", "parts": [{"type": "text", "text": question}]}]}
    response = requests.post(
        f"{endpoint.rstrip('/')}/api/chat", json=body, stream=True, timeout=600,
        headers={"x-riverguide-cache": "bypass"},
    )
    if response.status_code != 200:
        return {"response": "", "tool_calls": [], "usage": Counter(), "error": f"HTTP {response.status_code}: {response.text[:200]}", "notes": []}
    response.encoding = "utf-8"  # SSE is always UTF-8; requests would guess Latin-1 for text/*
    text, tool_calls, error, notes = [], [], None, []
    for line in response.iter_lines(decode_unicode=True):
        if not line or not line.startswith("data: ") or line == "data: [DONE]":
            continue
        part = json.loads(line[6:])
        if part["type"] == "text-delta":
            text.append(part["delta"])
        elif part["type"] == "data-tool":
            tool_calls.append({"name": part["data"]["name"], "input": part["data"]["input"]})
        elif part["type"] == "data-followups":
            notes.append(f"followups: {len(part['data']['questions'])}")
        elif part["type"] == "error":
            error = part.get("errorText")
    return {"response": "".join(text).strip(), "tool_calls": tool_calls, "usage": Counter(), "error": error, "notes": notes}


# ---------- tiers ----------


def run_full(system: System, items: list[dict], args: argparse.Namespace) -> list[dict]:
    client = None
    if args.system != "api" or args.judge:
        import anthropic

        load_api_key()
        client = anthropic.Anthropic(max_retries=6)

    def one(item: dict) -> dict:
        started = time.perf_counter()
        if args.system == "api":
            result = run_api(args.endpoint, item["question"])
        else:
            try:
                result = run_agent(client, system, item["question"], args.model, args.effort, args.max_rounds)
            except Exception as exc:  # anthropic.APIError, without importing it for the api system
                result = {"response": "", "tool_calls": [], "usage": Counter(), "error": f"API error: {exc}", "notes": []}
        reasons = system.grade(item, result)
        answer_reasons = text_reasons(item, result["response"])
        verdict = None
        if args.judge and item.get("expected_summary") and result["response"]:
            verdict = judge(client, args.model, item, result["response"], result["usage"])
            if not verdict.get("pass"):
                reasons.append(f"judge: {verdict.get('reason')}")
                answer_reasons.append(f"judge: {verdict.get('reason')}")
        if result["error"]:
            reasons.insert(0, result["error"])
            answer_reasons.insert(0, result["error"])
        row = {
            "id": item["id"],
            "category": item["category"],
            "passed": not reasons,
            "answer_passed": not answer_reasons,
            "reasons": reasons,
            "judge": verdict,
            "tool_calls": result["tool_calls"],
            "response": result["response"],
            "notes": result["notes"],
            "usage": dict(result["usage"]),
            "cost_usd": round(cost(result["usage"]), 4),
            "seconds": round(time.perf_counter() - started, 1),
        }
        mark = "PASS" if row["passed"] else "FAIL"
        print(f"{mark} {item['id']} ({len(row['tool_calls'])} tools, ${row['cost_usd']:.3f})", flush=True)
        return row

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        return list(pool.map(one, items))


def run_retrieval(items: list[dict]) -> list[dict]:
    """No model: run each question as one search and check the evidence is in the results."""
    from riverguide.index import default_index

    index = default_index()
    rows = []
    for item in items:
        if item["category"] == "out_of_scope" or item.get("must_call_tool") == "search_sections":
            continue
        results = index.search(item["question"], 8)
        evidence = "\n".join(f"{r['title']}\n{r['excerpt']}" for r in results).lower()
        reasons = [f"evidence missing {n!r}" for n in item.get("must_contain", []) if n.lower() not in evidence]
        if item.get("must_cite_url"):
            expected = {normalize_url(u) for u in item["must_cite_url"]}
            if not expected & {normalize_url(r["url"]) for r in results}:
                reasons.append("canonical page not in top 8")
        rows.append({"id": item["id"], "category": item["category"], "passed": not reasons, "reasons": reasons,
                     "top": [r["url"] for r in results[:3]]})
    return rows


# ---------- reporting ----------


def summarize(rows: list[dict], tier: str) -> dict:
    by_category: dict[str, list[int]] = {}
    for row in rows:
        tally = by_category.setdefault(row["category"], [0, 0, 0])
        tally[0] += row["passed"]
        tally[1] += row.get("answer_passed", row["passed"])
        tally[2] += 1
    summary = {
        "passed": sum(r["passed"] for r in rows),
        "total": len(rows),
        "by_category": {k: {"passed": v[0], "answer_passed": v[1], "total": v[2]} for k, v in sorted(by_category.items())},
    }
    if tier == "full":
        summary["answer_passed"] = sum(r["answer_passed"] for r in rows)
        summary["cost_usd"] = round(sum(r["cost_usd"] for r in rows), 2)
        summary["tool_calls"] = sum(len(r["tool_calls"]) for r in rows)
        summary["median_seconds"] = sorted(r["seconds"] for r in rows)[len(rows) // 2] if rows else 0
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the golden set.")
    parser.add_argument("--tier", choices=["retrieval", "full"], default="retrieval")
    parser.add_argument("--system", choices=["v2", "legacy", "api"], default="v2")
    parser.add_argument("--endpoint", default="http://127.0.0.1:8787", help="RiverGuide 2.0 base URL for --system api")
    parser.add_argument("--legacy", type=Path, default=REPO_ROOT.parent / "irsc-knowledge-base")
    parser.add_argument("--only", action="append", help="run one item id (repeatable)")
    parser.add_argument("--judge", action="store_true", help="grade narrative items against expected_summary")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--effort", default="medium", choices=["low", "medium", "high", "xhigh", "max"])
    parser.add_argument("--max-rounds", type=int, default=8)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()

    if args.tier == "retrieval" and args.system != "v2":
        parser.error("the retrieval tier measures v2's search index only")
    system = legacy_system(args.legacy.resolve()) if args.system == "legacy" else v2_system()
    if args.system == "api":
        import requests

        health = requests.get(f"{args.endpoint.rstrip('/')}/api/health", timeout=10).json()
        system.name = f"api-{health['model'].replace(':', '-').replace('/', '-')}"
    items = yaml.safe_load(system.golden.read_text(encoding="utf-8"))
    if args.only:
        items = [item for item in items if item["id"] in set(args.only)]
        if not items:
            parser.error(f"no golden items match {args.only}")

    started = dt.datetime.now(dt.timezone.utc)
    rows = run_retrieval(items) if args.tier == "retrieval" else run_full(system, items, args)
    summary = summarize(rows, args.tier)
    artifact = {
        "meta": {
            "system": system.name,
            "tier": args.tier,
            "model": (system.name if args.system == "api" else args.model) if args.tier == "full" else None,
            "effort": args.effort if args.tier == "full" else None,
            "judge": bool(args.judge),
            "started": started.isoformat(timespec="seconds"),
            "prompt_sha256": hashlib.sha256(system.prompt.encode()).hexdigest()[:12],
            "golden": str(system.golden),
            "partial": bool(args.only),
        },
        "summary": summary,
        "results": rows,
    }
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = started.strftime("%Y%m%dT%H%M%S")
    out = RUNS_DIR / f"{stamp}-{system.name}-{args.tier}{'-partial' if args.only else ''}.json"
    out.write_text(json.dumps(artifact, indent=2, ensure_ascii=False, default=str) + "\n", encoding="utf-8")

    print(f"\n{system.name} / {args.tier}: {summary['passed']}/{summary['total']} passed", end="")
    if args.tier == "full":
        print(f", answers {summary['answer_passed']}/{summary['total']}, ${summary['cost_usd']:.2f}, "
              f"{summary['tool_calls']} tool calls, median {summary['median_seconds']}s")
    else:
        print()
    for category, tally in summary["by_category"].items():
        print(f"  {category:14s} {tally['passed']}/{tally['total']}")
    for row in rows:
        if not row["passed"]:
            print(f"  FAIL {row['id']}: {'; '.join(row['reasons'])[:300]}")
    print(f"artifact: {out.relative_to(REPO_ROOT)}")
    return 0 if summary["passed"] == summary["total"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
