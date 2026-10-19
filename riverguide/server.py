"""RiverGuide MCP server: three read-only tools over the College's own pages.

    search(query)          best-matching passages from official pages
    read_page(url)         the full text of one official page
    search_sections(term)  public class listings for a term (dated snapshot)

Streamable HTTP at /mcp for Copilot Studio, or --stdio for local MCP clients.
Environment variables keep RiverGuide 1's names, so the existing Azure
Container App and Copilot Studio connection work by swapping the image:

    IRSC_MCP_API_KEY        bearer token (required anywhere but loopback)
    IRSC_MCP_ALLOWED_HOSTS  extra Host headers, e.g. the container app FQDN
    IRSC_MCP_HOST / _PORT   bind address (default 127.0.0.1:8765)
    IRSC_BUILD_SHA          reported as MCP serverInfo.version (default: the
                            checkout's git commit)
"""
from __future__ import annotations

import hmac
import json
import logging
import os
import subprocess
import sys
import time
import warnings
from pathlib import Path
from typing import Any

# The MCP SDK's settings model warns at import on Python 3.14; it is harmless.
warnings.filterwarnings("ignore", message="Field 'lifespan'")

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations

from riverguide import sections
from riverguide.index import default_index

READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)


def _transport_security() -> TransportSecuritySettings:
    extra = [h.strip() for h in os.environ.get("IRSC_MCP_ALLOWED_HOSTS", "").split(",") if h.strip()]
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=["127.0.0.1:*", "localhost:*", "[::1]:*", *extra],
        allowed_origins=[
            "http://127.0.0.1:*",
            "http://localhost:*",
            "http://[::1]:*",
            "null",  # Copilot Studio's designer sends Origin: null from a sandboxed iframe
            "https://copilotstudio.microsoft.com",
            "https://*.powerva.microsoft.com",
            *(f"https://{h}" for h in extra),
        ],
    )


mcp = FastMCP(
    name="riverguide",
    instructions=(
        "Indian River State College's official web pages and public class listings. "
        "Search before answering anything about the College, and link the url of "
        "each page you use."
    ),
    transport_security=_transport_security(),
)
def _build_version() -> str | None:
    if os.environ.get("IRSC_BUILD_SHA", "").strip():
        return os.environ["IRSC_BUILD_SHA"].strip()
    try:
        head = subprocess.run(
            ["git", "-C", str(Path(__file__).resolve().parent), "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=5, check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return head.stdout.strip() or None


if version := _build_version():
    mcp._mcp_server.version = version


def _log(tool: str, started: float, **fields: Any) -> None:
    # Outcomes and timing only. Never log query text: students type personal details.
    record = {"event": "tool", "tool": tool, "ms": round((time.perf_counter() - started) * 1000, 1), **fields}
    print(json.dumps(record), file=sys.stderr, flush=True)


@mcp.tool(annotations=READ_ONLY)
def search(query: str, limit: int = 8) -> dict:
    """Search Indian River State College's official website (irsc.edu) and College catalog.

    Use for anything about the College: admissions, the academic calendar and
    deadlines, tuition and fees, financial aid, programs and requirements,
    courses (credits, prerequisites), policies, offices and contacts, campus
    services, and how-to steps. Write short keyword queries, for example
    "drop deadline fall 2026", "ENC 1101", or "student help desk phone". If the
    results miss, search again with other words: the official name, a
    spelled-out acronym, or the office that owns the topic. Run several
    searches at once when a question has several parts.

    Each result has the page title, url, the date its content last changed
    (updated), and an excerpt. Use read_page for the whole page.
    """
    started = time.perf_counter()
    index = default_index()
    results = index.search(query, limit)
    _log("search", started, results=len(results), query_chars=len(query))
    if not results:
        return {
            "checked": index.checked,
            "results": [],
            "note": "No matching pages. Try different words, an official name, or a spelled-out acronym.",
        }
    return {
        "checked": index.checked,
        "results": results,
        "note": (
            "Excerpts from official College pages, all re-checked against the live site on the "
            "'checked' date. Quote dates, amounts, and contacts exactly as written."
        ),
    }


@mcp.tool(annotations=READ_ONLY)
def read_page(url: str, start: int = 0) -> dict:
    """Read the full text of an official College page, by its url from search results.

    Use when an excerpt is cut off or you need the rest of a table, list, or
    policy. Long pages come in parts: pass next_start as start to keep reading.
    """
    started = time.perf_counter()
    page = default_index().read(url, start)
    _log("read_page", started, found=page is not None)
    if page is None:
        return {"error": "That url is not one of the College pages in the index. Use search to find official pages."}
    return page


@mcp.tool(annotations=READ_ONLY)
def search_sections(
    term: str,
    course_code: str | None = None,
    crn: str | None = None,
    keyword: str | None = None,
    delivery: str | None = None,
    campus: str | None = None,
    open_only: bool = False,
    limit: int | None = None,
) -> dict:
    """Public class listings for one term from the latest schedule snapshot.

    Answers whether a course is offered in a term, online/hybrid/in person,
    campus, CRN, meeting days and times, and reported open/full status. term is
    required, e.g. "Fall 2026". Filter with course_code ("ENC 1101"), keyword,
    delivery (online, online_async, online_live, hybrid, in_person), campus
    (Massey, Pruitt, Chastain, Mueller, Dixon Hendry, Blackburn, River Online),
    or open_only.

    Results are a dated snapshot, not live registration. Zero matches means no
    public match in that snapshot, not that the course is never offered. Not
    for a student's own schedule, and not for whether a whole program is
    online (use the program's catalog page for that).
    """
    started = time.perf_counter()
    result = sections.search_sections(term, course_code, crn, keyword, delivery, campus, open_only, limit)
    _log("search_sections", started, matches=result["match_count"], covered=result["coverage"]["covered"])
    return result


# ---------- HTTP: bearer auth ----------

AUTH_FAILURES = {
    "missing_authorization_header": "Missing Authorization header. Expected: Authorization: Bearer <token>.",
    "malformed_authorization_header": "Malformed Authorization header. Expected: Authorization: Bearer <token>.",
    "unsupported_authorization_scheme": "Unsupported Authorization scheme. Expected: Authorization: Bearer <token>.",
    "missing_bearer_token": "Bearer Authorization header is present but the token value is empty.",
    "invalid_bearer_token": "Bearer token is present but does not match the configured MCP token.",
}


def auth_failure(header: bytes | None, expected: bytes) -> str | None:
    if not header:
        return "missing_authorization_header"
    scheme, separator, token = header.partition(b" ")
    if not separator:
        return "malformed_authorization_header"
    if scheme.lower() != b"bearer":
        return "unsupported_authorization_scheme"
    if not token.strip():
        return "missing_bearer_token"
    if not hmac.compare_digest(token.strip(), expected):
        return "invalid_bearer_token"
    return None


class BearerAuth:
    """ASGI middleware requiring Authorization: Bearer <token>. CORS preflights pass."""

    def __init__(self, app, token: str):
        self.app = app
        self.expected = token.encode()

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") == "OPTIONS":
            await self.app(scope, receive, send)
            return
        reason = auth_failure(dict(scope.get("headers", [])).get(b"authorization"), self.expected)
        if reason is None:
            await self.app(scope, receive, send)
            return
        print(json.dumps({"event": "auth_failed", "reason": reason, "path": scope.get("path")}), file=sys.stderr)
        body = json.dumps({"error": "unauthorized", "detail": AUTH_FAILURES[reason], "reason": reason}).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 401,
                "headers": [(b"content-type", b"application/json"), (b"www-authenticate", b'Bearer realm="riverguide"')],
            }
        )
        await send({"type": "http.response.body", "body": body})


def main() -> int:
    if "--stdio" in sys.argv:
        mcp.run(transport="stdio")
        return 0

    import uvicorn

    for noisy in ("mcp.server.lowlevel.server", "mcp.server.streamable_http_manager"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    host = os.environ.get("IRSC_MCP_HOST", "127.0.0.1")
    port = int(os.environ.get("IRSC_MCP_PORT", "8765"))
    token = os.environ.get("IRSC_MCP_API_KEY", "").strip()
    started = time.perf_counter()
    pages = len(default_index().pages)
    print(f"riverguide: indexed {pages} pages in {time.perf_counter() - started:.1f}s", file=sys.stderr)

    app = mcp.streamable_http_app()
    if token:
        app = BearerAuth(app, token)
        print(f"riverguide listening on http://{host}:{port}/mcp (bearer auth required)", file=sys.stderr)
    elif host not in ("127.0.0.1", "localhost", "::1"):
        print("refusing to serve without IRSC_MCP_API_KEY on a non-loopback address", file=sys.stderr)
        return 2
    else:
        print(f"riverguide listening on http://{host}:{port}/mcp (no auth: loopback only)", file=sys.stderr)
    uvicorn.run(app, host=host, port=port, log_level=os.environ.get("IRSC_MCP_LOG_LEVEL", "warning"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
