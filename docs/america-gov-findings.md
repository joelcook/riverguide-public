# Why RiverGuide 2.0 exists: what we learned from America.gov

*Research done 2026-10-14. America.gov launched 2026-09-29; anything about its internals can change without notice.*

## The short version

America.gov answers questions about roughly 29,000 government websites, and it does it without keeping a knowledge base. There is no wiki, no compiled summaries, no fact tables, and no vector database. A reasoning model (very likely xAI's Grok) runs a short loop: it writes its own search queries against a pre-crawled, government-only keyword index, reads the page text that comes back, and answers with links to those pages. A government-run crawler keeps the index fresh. A two-hour answer cache absorbs repeat questions. An open-source filter in the browser stops personal information before it is sent.

RiverGuide 1 solved the same problem for one college by compiling the College's pages into an LLM wiki plus eleven fact tables, behind twelve tools. That design made every fact live in two places, and most of v1's machinery (lints, rewrite jobs, fact projections, a routing table in the prompt) existed to keep the second copy honest. America.gov shows the second copy is unnecessary. RiverGuide 2.0 keeps one copy, the College's own pages, and lets the model read them.

## How we investigated

- Read America.gov's own pages: How it works, FAQ, Privacy, the Privacy Policy, Terms, and `robots.txt`.
- Downloaded and read the site's JavaScript bundles (about 160 files) to find the chat API, the stream format, and the privacy code.
- Asked America.gov three real questions in a browser and recorded the raw `/api/chat` response streams:
  1. "What is the FAFSA deadline for the 2027-28 school year, and how do I qualify for a Pell Grant at a community college in Florida?"
  2. A follow-up: "Where is the nearest place I can apply for a passport in person?"
  3. Question 1 again in a fresh chat, to test caching.
- Read public GitHub repositories: National Design Studio's `rampart`, and GSA's `site-scanning`, `federal-website-index`, `searchgov-spider`, and `search-gov`.
- Read news coverage, the National Design Studio's engineering blog, Google's announcement, and the lead engineer's public X posts.

Each finding below says how we know it: **observed** (we saw it in the site or its traffic), **documented** (America.gov or GSA says so), or **inferred** (strong evidence, not confirmed).

## What America.gov is

- Built by the White House **National Design Studio** (NDS), created by Executive Order 14338 on 2025-08-21, and operated by the **General Services Administration**. (documented)
- Launched 2026-09-29. Phase 1 answers questions; phase 2 (2027) is meant to let people apply, enroll, and track progress in chat. (documented)
- It calls its AI "Super Intelligence (SI)" throughout the site. (observed)
- Chief Design Officer Joe Gebbia told CNBC it runs on Google's Gemini and xAI's Grok. Google's announcement says only that it is "leveraging Gemini." xAI did not comment. (documented)
- President Trump named Edward Coristine (@as400495) the lead engineer at the launch. Coristine publicly credited @taigrr (Tai Groot), @caelin_sutch, @ahmadaccino, and GSA career staff. (documented)

## Findings

### 1. The site is static and runs on Cloudflare

- The pages are a static **Astro** site with React islands, served from Cloudflare's edge (`cf-cache-status: HIT`). (observed)
- The Content Security Policy allows the page to talk only to its own origin (`connect-src 'self'`), so every AI call goes through America.gov's own `/api/chat`. The browser never talks to a model provider directly. (observed)
- Cloudflare also handles rate limiting and security logs. (documented)

### 2. The chat is an agentic search loop: model, search tool, answer

- The browser posts to `/api/chat`, which streams back a **Vercel AI SDK UI message stream** (`x-vercel-ai-ui-message-stream: v1`, `text/event-stream`). (observed)
- Each answer took **2 to 3 model steps**. We saw two tools:
  - `ground`: search over government websites. The model often called it twice in parallel with different queries.
  - `request_user_location`: the visitor's approximate city or region, taken from their IP address. The model asked for it only when the question needed it. (observed)
- The client gives `ground` its own status line ("Checking official sources…") and a generic one to any other tool, so there may be more tools we didn't trigger. (observed)
- There is **no vector database, embedding step, or compiled knowledge** visible anywhere. Retrieval is search at question time. (observed)

What the three test questions did:

| Question | What happened | Time |
|---|---|---|
| FAFSA + Pell (new chat) | Step 1: two `ground` searches in parallel, returning 8 and 21 pages. Step 2: the answer. | first words at 5.3 s, done at 16.0 s |
| Passport follow-up | Step 1: `request_user_location` and a `ground` search in parallel (7 pages). Step 2: a second search that found county clerk and CBP pages near the visitor (10 pages). Step 3: the answer. | similar |
| FAFSA + Pell again (new chat) | The same 2,445-character answer with the same sources, replayed from cache | **0.86 s** total, 122 ms on the server |

### 3. Search returns real page text from a government-only index

- Each search result carries a title, URL, and a `currency` flag (`verified` or `unverified`). Every result we saw was `unverified`. (observed)
- A search returned 7 to 21 pages. From the size of the encrypted tool results, each page contributed roughly **1.5 to 2 KB of extracted text**, not just a snippet. (inferred)
- Every source was a government domain: federal (studentaid.gov, fsapartners.ed.gov, travel.state.gov, cbp.gov, regulations.gov), state (michigan.gov, maryland.gov, flsenate.gov), and county (a county clerk's office). (observed)
- The index is **not curated for freshness**. It returned 1998 and 1999 Florida statutes and a 1998-99 federal aid handbook. The model ignored them and answered from current pages. (observed)
- America.gov's privacy policy describes this as searches "across government websites in a secure, sandboxed version of the Internet." (documented)

### 4. Answers quote the page and link it

- The FAFSA answer gave exact deadlines (June 30, 2028; corrections by September 12, 2028; Florida state aid processed by May 15, 2027), with inline Markdown links to the pages. (observed)
- When a fact wasn't published yet, it said so: "The 2027–28 maximum Pell amount was not posted yet on StudentAid.gov when this was checked." (observed)
- Three suggested follow-up questions arrive with each answer. (observed)

### 5. Scale comes from caching, statelessness, and pushing work to the browser

- **Answer cache:** responses are stored in **Cloudflare KV for up to two hours**, keyed by a hash of the prompt. A repeat question is served in about a tenth of a second for almost no cost. Search results are also cached for two hours, and suggested follow-ups for 30 days. (documented and observed)
- **No server-side conversations:** the server stores no chat history. Tool inputs and results, the model's reasoning, and which model answered are all encrypted ("sealed") before they reach the browser. The history is signed (a 64-hex-character signature), so the browser can hold it without tampering. The browser sends it back each turn, and the server can be scaled out freely. (observed)
- **Work moved to the browser:** the PII check, PDF text extraction, and speech-to-text all run on the visitor's device, at no server cost. (observed and documented)

### 6. The answering model is very likely Grok

- Reasoning items in the stream have IDs like `rs_d53d500c-c5c3-904f-996d-1be3a57d659f`, with message IDs sharing the same UUID (`msg_…`). The UUIDs carry an unusual version digit of 9. That matches the format xAI's Responses API returns: a published grok-4.6 capture shows `rs_dcfdfd32-5ca4-954d-8d94-3edf6a41315b`. OpenAI and Gemini IDs look different. (inferred, strong)
- Encrypted reasoning is round-tripped through the browser, which matches xAI's stateless "encrypted reasoning content" feature. (observed)
- **Gemini's role is not visible from the browser.** It could be a fallback model, the follow-up generator, a safety classifier, or part of the search step. (unknown)

### 7. Privacy: Rampart runs in the browser

- **Rampart** is NDS's open-source on-device PII filter (`github.com/nationaldesignstudio/rampart`), by Tai Groot and Edward Coristine. It pairs deterministic rules (SSNs, card numbers with Luhn checks, emails, phone numbers, IDs) with a 14.7 MB MiniLM model that catches names and addresses. NDS reports 98.4% private-term recall across seven languages. For comparison, it reports 65% for Microsoft Presidio and 97.4% for OpenAI's 2.8 GB privacy filter. (documented)
- On America.gov it runs through onnxruntime-web (WebAssembly in a worker), loaded from America.gov's own `/models/` path. (observed)
- A typed message that contains personal information is **blocked, not silently altered**: the details are highlighted and the visitor is asked to edit. Full street addresses are refused ("Use your city, town or ZIP code"). (observed)
- An uploaded PDF is read in the browser (pdf.js plus a LiteParse WebAssembly build), and personal details are removed automatically ("Anonymizing…"). (observed)
- Limits: 8,000 characters per message and 10 MB per PDF. Voice uses the browser's own speech recognition. (observed)
- The model providers operate under zero-data-retention agreements. Operational metrics (model and tool outcomes, timing, token counts) are kept 90 days. Feedback is kept one year together with the answer and its sources. (documented)

### 8. Safety rails are product features, not prompt text alone

- Crisis cards: the 988 Lifeline, and the Veterans Crisis Line for veterans. (observed)
- The model can end a conversation ("America has ended this chat."). (observed)
- A blocked-word filter on responses triggers an automatic regenerate. Inputs, prompts, and responses each have their own "blocked" message. (observed)
- Feedback has a reviewer mode that asks for name, title, and agency, which suggests agency staff review answers. (observed)
- Easter eggs: the Konami code switches to a 1983 "retro" style, and "take me back to FirstGov" switches to a 2001 style. (observed)

### 9. The index belongs to someone else: GSA's Search.gov

- **"29,000 government websites" is GSA's Federal Website Index**: 29,835 federal website hostnames across about 1,400 domains, maintained by GSA's Site Scanning program. (documented)
- A GSA issue titled "track integration with america.gov" (`GSA/site-scanning#2007`, 2026-09-24) links that number to files in America.gov's monorepo, `GSA-TTS/america` (now private): `apps/searchgov/src/lib/public-website-inventory.ts` and `apps/searchgov/src/aws-ingestion-services.ts`. America.gov has an app named **searchgov** with ingestion running on AWS. (documented)
- Search.gov's public crawler (`GSA-TTS/searchgov-spider`) shows what that kind of index looks like (documented):
  - Scrapy crawls of about 1,670 federal and `.mil` site configurations, re-crawled weekly at depth 3 to 8.
  - Main-text extraction (newspaper4k) and PDF text (pypdf), into **OpenSearch, a plain keyword (BM25) index with no vectors**.
  - A daily freshness checker re-checks documents not updated in 8 days.
  - Ranking uses traffic counts from GSA's Digital Analytics Program.
- Search.gov **removed Bing on 2026-09-22**, one week before launch, so results now come from its own index. It added Redis caching of index queries on 2026-10-05. (documented)
- Caveat: America.gov also cited state and county sites that are not in that federal crawl, so `ground` searches more than Search.gov's federal index. Its exact backend is hidden behind the encryption. (inferred)

### 10. Loose ends in the coverage

- Gebbia also described the system as "trained specifically on one official source of truth," which conflicts with the retrieval design we observed. The traffic shows retrieval. (documented)
- One outlet quoted an official naming Grok and OpenAI rather than Gemini. Nobody has reconciled the vendor list. (documented)
- The chat failed for part of launch day ("Chat is unavailable right now"). (documented)

### 11. Re-checked 2026-10-19: Rampart Edge, the first page load, and the typeahead

- **A first visit loads about 5.2 MB in 190 requests**, measured in a fresh headless Chromium profile. About half is the privacy filter (2.7 MB). The rest is images (1.2 MB, mostly agency seals and logos), JavaScript (0.7 MB, Astro with React islands), the server-rendered HTML (0.29 MB), and fonts (0.23 MB). The first paint came at about 0.2 s and the load event at 0.5 s. (observed)
- **America.gov now runs Rampart Edge**, the 1.45 MB model RiverGuide uses. Its model and its trimmed ONNX Runtime engine are byte-for-byte the files in the `@nationaldesignstudio/rampart-edge` npm package (same SHA-256). It runs on the CPU in WebAssembly, not WebGPU. The gate runs on the page with onnxruntime-web's `proxy` option, so only the model's math runs in a worker. The page starts fetching the model about 0.65 s after navigation. (observed)
- **The typeahead runs entirely in the browser.** Focusing the question box loads nothing. The first keystroke loads an 8.5 KB matcher and a 213 KB dictionary (24 KB compressed). After that, no keystroke makes a request. (observed)
  - The dictionary has 2,045 questions, each with a `prior` (how likely it is). 551 are prompts ("Renew my passport"), 102 are written out ("I lost my job what benefits can I get?"), and 1,392 come from templates with slots ("How do I renew my {passport, green card, …}?"). A required slot keeps variants hidden until the visitor types into it ("Register to vote in {state}"). (observed)
  - Matching is word by word. Each finished word may be one typo off (three to six letters) or two (seven or more), and the word being typed must start the question's word. After three letters a question can match from any word, but questions that match from their start win. Fewer typos win, then the higher prior, then the shorter question. The three suggestions get different next words where possible. Typing a "?" or a number with four or more digits shows nothing. English only. (observed)
  - The first suggestion is highlighted, but Enter sends what was typed. Tab puts the highlighted suggestion in the box. A click sends it. Escape closes the list. (observed)
  - The bundle also has a word-level next-word model (469 KB) that the page never loads. (observed)

## What it means

America.gov's chat backend is roughly **a prompt, two tools, and a cache**. Everything else is design, privacy, and safety. It handles "millions of records" by not copying them:

1. **Someone else keeps the index fresh.** A crawler re-reads the sites on a schedule. Freshness comes from re-crawling, not from re-writing summaries.
2. **The model writes the queries.** A plain keyword index is enough because the model rephrases, searches in parallel, and searches again. No synonym tables, no embeddings.
3. **Answers quote the page they came from, at question time, with a link.** The source of truth is never a second copy.
4. **Cost and load are handled outside the model.** Repeat questions are cached, the server is stateless, and privacy work runs in the browser.

## Why we built RiverGuide 2.0

RiverGuide 1's own README describes it as the opposite bet: "scrape the official sources well, keep the corpus small enough to actually govern." It works. But governing it means a nightly scrape and rebuild, a `watch_main` job every 5 minutes, an automatic stale-wiki rewrite every 30 minutes, 77 compiled pages, 11 fact tables, a lint that bans dates and dollar amounts from prose, and a prompt that routes between 12 tools.

The key realization: **the fact tables and the lints exist because the wiki is a second copy of the website, and copies go stale.** v1 forbids dates in wiki prose precisely because compiled prose drifts from the source. America.gov never compiles anything, so quoting a date from the page is safe: the page text is as fresh as the last crawl. Remove the copy, and most of the machinery has nothing left to protect.

| | RiverGuide 1 | RiverGuide 2.0 |
|---|---|---|
| Knowledge | 77 wiki pages + 11 fact tables | the 2,404 official pages themselves |
| Tools | 12, routed by the prompt | 3: `search`, `read_page`, `search_sections` |
| Prompt | 1,228 words | about 700 words |
| Code | about 21,000 lines | about 2,000 lines |
| Keeping facts right | lints, rewrite jobs, fact projections | re-crawl nightly; quote and link the page |
| When an answer is wrong | fix the wiki or the projection | fix the page on irsc.edu, then re-crawl |

### What we copied from America.gov, and what we didn't

| America.gov | RiverGuide 2.0 | Why |
|---|---|---|
| Search.gov's crawler and keyword index | `riverguide/crawl.py` writes `corpus/` (one markdown file per page); an in-memory SQLite FTS5 (BM25) index built at startup in about 0.1 s | Same idea, at college scale. 2,404 pages fit in memory. |
| `ground` (search, returns page text) | `search` (excerpts of about 2 KB per page, with title, URL, and dates) plus `read_page` (the full page) | `read_page` covers long tables such as the academic calendar. |
| Model writes queries, searches in parallel | Same; the prompt says to search again with other words | No synonym lists to maintain. |
| Answers quote pages and link them | Same, plus a server-side link guard: only real College pages or links from this turn's results reach the student | This replaces v1's hard-fact routing. |
| Static site + `/api/chat` on Cloudflare, Vercel AI SDK stream | Same: a Worker serves the page and `/api/chat` with the AI SDK UI message stream | Copilot Studio is retired at cutover. |
| Weekly crawl plus freshness checks | Nightly crawl on omarchy; rewrites only changed pages, deletes only on 404/410, fails closed | Same freshness model. |
| Grok (plus Gemini) | One setting in `web/wrangler.jsonc` (xAI, Anthropic, or Qwen via Ollama for development) | The golden set, run against `/api/chat`, picks the model. |
| `request_user_location` | Not needed | One college. |
| Records that aren't pages | `search_sections` for public class listings (a dated snapshot) | The one kind of record that isn't a web page. |
| Two-hour answer cache | Workers KV, 2 hours, keyed by question + prompt + crawl date + model | A repeat question comes back in about 15 ms. |
| Rampart, now Rampart Edge, in the browser | Rampart Edge (the same model and engine): blocks and highlights personal information; model and runtime served from our own site; the College's own phone numbers and street addresses pass | RiverGuide has its own front end now. |
| All-local typeahead over 2,045 written questions with popularity priors | The same matching, over questions from the College's pages (FAQ questions, three per catalog course) and a short list of what students ask most (`web/app/examples.ts`) | We keep no record of what students type, so the order comes from the pages (general before specific, introductory courses first). |
| Sealed, signed, stateless history | Signed (HMAC-SHA256), stateless; only text is replayed, tool results are re-fetched | Nothing to seal: tool results are public pages. |
| Crisis cards, end-chat, blocked words | 988 crisis card, plus rules in `prompt.md`; no end-chat or blocked-word regenerate yet | |

### What we kept from RiverGuide 1

- The golden release set (53 questions), with every answer check unchanged. Only the tool checks were translated to the new tools.
- The course-section data contract and its sanitized snapshot.
- The MCP server's environment variable names, bearer auth, and `/mcp` path.
- The safety rules: no student records, no social engineering, crisis first, no live chat.

## Trade-offs and risks

- **The answer is only as good as the page.** If irsc.edu is wrong or stale, RiverGuide will be too, and it will link the wrong page. The fix is upstream: correct the page, and the next crawl picks it up. America.gov carries the same risk and puts "SI can make mistakes, check the sources" on every page.
- **Search quality is everything.** A keyword index can miss a page that uses different words. The model can rephrase, but a miss means "I couldn't confirm that," not a wrong answer. The golden set's free retrieval tier tracks this.
- **Old pages stay in the index.** America.gov surfaced 1998 statutes. We crawl only current College pages, but outdated pages on irsc.edu will still be searchable until the College removes them.
- **Facts that aren't on the website** (for example, where students get a 1098-T) can't be found. They live in a short "not on the website yet" list in `prompt.md`, and the real fix is publishing them.
- **The golden comparison against v1 hasn't run yet.** It needs a working Anthropic API key (`python -m evals.run --tier full --judge`, then the same with `--system legacy`).

## Status (2026-10-14)

- Running on omarchy as the `riverguide` user service on `127.0.0.1:8765`.
- First full crawl on the box (2026-10-14): 2,386 pages fetched in about an hour, 272 changed since v1's Oct 6 scrape (mostly formatting), 20 deleted because the site now returns 404 (including the finished Summer 2026 calendar), 1 new page. The nightly job runs at 04:30.
- Not public yet. Next steps:
  1. Add a tunnel hostname pointing at `127.0.0.1:8765`.
  2. Run the golden comparison.
  3. Switch Copilot Studio to the new MCP URL and `prompt.md`.
  4. Retire v1's cron jobs on omarchy.
  5. Port the course-section importer.

## Sources

America.gov:
- https://america.gov/how-it-works
- https://america.gov/faq
- https://america.gov/privacy
- https://america.gov/privacy-policy
- https://america.gov/terms
- https://america.gov/robots.txt

NDS and GSA:
- https://github.com/nationaldesignstudio/rampart
- https://ndstudio.gov/posts/say-hello-to-rampart
- https://github.com/GSA/site-scanning/issues/2007
- https://github.com/GSA/federal-website-index
- https://github.com/GSA-TTS/searchgov-spider
- https://github.com/GSA/search-gov (pull requests #2161, removing Bing, and #2177, Redis caching)
- https://github.com/openai/codex/issues/47733 (published xAI reasoning-ID format)

Coverage:
- https://www.cnbc.com/2026/09/29/trump-ai-gemini-grok.html
- https://fedscoop.com/trump-launches-ai-site-america-gov/
- https://blog.google/company-news/outreach-and-initiatives/public-policy/america-gov-google-public-sector/
- https://www.theageofstars.com/features/america-gov/
- https://tech-insider.org/america-gov-ai-chatbot-gemini-grok-2026/
- https://en.wikipedia.org/wiki/Edward_Coristine
- https://x.com/as400495
