# RiverGuide 2.0: rules for agents and humans

RiverGuide answers students from Indian River State College's own web pages. Keep it that way, and keep it small.

## The rules

1. **The College's pages are the only knowledge.** `corpus/` is written by `riverguide/crawl.py` (or, during the transition, `scripts/import_legacy.py`). Never hand-edit it. If a page is wrong or missing, the fix is on irsc.edu or in the catalog, followed by a re-crawl.
2. **No second copy.** Don't add a wiki, summaries, fact tables, or synonym lists. If the model can't find something, improve search for everyone (chunking, ranking) or get the page published. The one exception is `prompt.md`'s short "not on the website yet" list. Keep it short and delete entries once the College publishes them. The typeahead's own questions (`web/app/examples.ts`) are questions, never answers; the rest of its dictionary is built from `corpus/`.
3. **Three tools.** `search`, `read_page`, and `search_sections`. A new tool needs a kind of record that is not a web page, like course sections were. The Worker (`web/src/search.ts`) and `riverguide/index.py` must rank identically; `tests/test_export_d1.py` checks it.
4. **Course sections are protected-source data.** Follow `docs/sections-data-contract.md`: public, allowlisted fields only, and always a dated snapshot.
5. **`prompt.md` is what students get.** The Worker bundles it and appends today's date; the evals read the same file.
6. **The golden set is the gate.** Run `python -m unittest discover -s tests -t .` and `cd web && bun run check` for every change, and `python -m evals.run --tier full --system api` for any change to the prompt, the tools, search, or the model. Answer checks in `evals/golden.yaml` change only when the College's facts change.
7. **Don't log what students type.** Logs record outcomes and timing only. Feedback is stored only when a student rates an answer.
8. **The web app is Bun and plain TypeScript.** No React, ever; no framework unless there's a real argument for one. Use `bun`/`bunx`, not npm. Brand styles come from `irsc-brand/scripts/sync.py`; never edit the bundle between the `irsc-brand` markers. The page serves its own open fonts (Aleo, Instrument Sans) on purpose, an exception to irsc-brand's no-fonts rule decided 2026-10-15.
9. **Nothing reaches the student unchecked.** Personal information is blocked in the browser (Rampart Edge), links pass the server's link guard, and history is signed. Don't weaken these to make an eval pass.

## Where things run

| Plane | What | Where |
|---|---|---|
| Crawl | refresh `corpus/`, then load it into D1 | omarchy cron, 04:30: `deploy/omarchy/nightly.sh` (the only writer of `corpus/`) |
| Chat | page, `/api/chat`, Rampart Edge's model | Cloudflare Worker `riverguide` with D1 `riverguide` and KV `riverguide-cache` |
| Model | answers | one setting in `web/wrangler.jsonc`; Qwen on omarchy (Ollama) for local development only |

omarchy is a shared production box: keep services on loopback and ask before changing anything public (tunnel hostnames, Worker routes and domains).
