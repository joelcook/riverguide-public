#!/usr/bin/env python3
"""Smoke-test a running RiverGuide MCP server the way Copilot Studio uses it.

    .venv/bin/python scripts/check_server.py                                   # local server
    .venv/bin/python scripts/check_server.py --endpoint https://<app>/mcp      # production
                                                                             # (token from IRSC_MCP_API_KEY)
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client


async def check(endpoint: str, token: str) -> int:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    async with streamablehttp_client(endpoint, headers=headers) as (read, write, _):
        async with ClientSession(read, write) as session:
            init = await session.initialize()
            print(f"ok initialize: {init.serverInfo.name} {init.serverInfo.version}")
            tools = sorted(t.name for t in (await session.list_tools()).tools)
            print(f"ok tools/list: {tools}")
            if tools != ["read_page", "search", "search_sections"]:
                print("FAIL: unexpected tool list", file=sys.stderr)
                return 1
            result = await session.call_tool("search", {"query": "drop deadline fall 2026", "limit": 3})
            payload = json.loads(result.content[0].text)
            top = payload["results"][0]
            print(f"ok tools/call search: {top['title']} ({top['url']}), checked {payload['checked']}")
            sections = await session.call_tool("search_sections", {"term": "Fall 2026", "course_code": "ENC 1101"})
            print(f"ok tools/call search_sections: {json.loads(sections.content[0].text)['match_count']} ENC 1101 sections")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--endpoint", default="http://127.0.0.1:8765/mcp")
    parser.add_argument("--token", default=os.environ.get("IRSC_MCP_API_KEY", ""))
    args = parser.parse_args()
    return asyncio.run(check(args.endpoint, args.token))


if __name__ == "__main__":
    raise SystemExit(main())
