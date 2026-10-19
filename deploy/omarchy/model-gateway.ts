// The model behind RiverGuide's Worker while RiverGuide runs on Qwen: a narrow, authenticated
// door to Ollama for the Cloudflare Worker, reached through the riverguide-model tunnel.
// Loopback only. One route, one model, capped size and tokens, a few requests at a time.
// Logs outcomes and timing, never message text.
//
//   bun deploy/omarchy/model-gateway.ts      (RIVERGUIDE_MODEL_TOKEN from the environment)
import { timingSafeEqual } from "node:crypto";

const TOKEN = process.env.RIVERGUIDE_MODEL_TOKEN ?? "";
const OLLAMA = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const MODEL = process.env.RIVERGUIDE_MODEL ?? "qwen3.8:27b";
const PORT = Number(process.env.RIVERGUIDE_MODEL_PORT ?? 8790);
const MAX_BODY_BYTES = 1_000_000;
const MAX_TOKENS = 4000;
const MAX_IN_FLIGHT = 4; // Ollama runs one at a time here; more than this just waits
const TIMEOUT_MS = 300_000;

if (TOKEN.length < 32) {
  console.error("RIVERGUIDE_MODEL_TOKEN must be set (32+ characters)");
  process.exit(2);
}
const expected = Buffer.from(`Bearer ${TOKEN}`);
let inFlight = 0;

const reply = (status: number, error: string, headers: Record<string, string> = {}) =>
  Response.json({ error: { message: error } }, { status, headers });
const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ event: "model", ...fields }));

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 255,
  async fetch(request) {
    const started = Date.now();
    const { pathname } = new URL(request.url);
    const auth = Buffer.from(request.headers.get("authorization") ?? "");
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      log({ status: 401 });
      return reply(401, "Unauthorized.");
    }
    if (pathname === "/health") return Response.json({ model: MODEL, in_flight: inFlight });
    if (pathname !== "/v1/chat/completions" || request.method !== "POST") return reply(404, "Not found.");
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return reply(413, "Request too large.");
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw);
    } catch {
      return reply(400, "Malformed JSON.");
    }
    if (body.model !== MODEL) return reply(400, `Only ${MODEL} is served here.`);
    for (const key of ["max_tokens", "max_completion_tokens"]) {
      if (key in body) body[key] = Math.min(Number(body[key]) || MAX_TOKENS, MAX_TOKENS);
    }
    if (!("max_tokens" in body) && !("max_completion_tokens" in body)) body.max_tokens = MAX_TOKENS;
    if (inFlight >= MAX_IN_FLIGHT) {
      log({ status: 503, in_flight: inFlight });
      return reply(503, "RiverGuide is busy. Try again in a minute.", { "retry-after": "30" });
    }

    inFlight++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlight--;
      log({ status: 200, ms: Date.now() - started, stream: Boolean(body.stream), in_flight: inFlight });
    };
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(TIMEOUT_MS)]);
    signal.addEventListener("abort", release, { once: true });
    try {
      const upstream = await fetch(`${OLLAMA}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (!upstream.body) {
        release();
        return reply(502, "The model returned nothing.");
      }
      const passthrough = upstream.body.pipeThrough(new TransformStream({ flush: release }));
      return new Response(passthrough, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
      });
    } catch (error) {
      release();
      log({ status: 502, error: String(error).slice(0, 200) });
      return reply(502, "The model is unavailable.");
    }
  },
});
console.log(`riverguide model gateway on http://127.0.0.1:${PORT} -> ${OLLAMA} (${MODEL})`);
