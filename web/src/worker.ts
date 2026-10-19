// RiverGuide 2.0 on Cloudflare: the static chat page plus three API routes.
//   POST /api/chat       the answer loop (chat.ts)
//   POST /api/feedback   thumbs up/down, kept with the question, answer, and sources
//   GET  /api/health     corpus date and model, for checks and the eval runner
//   GET  /models/*.onnx  Rampart Edge's model, stored gzipped and served compressed

import { handleChat, type Env } from "./chat";
import { checkedDate } from "./search";

const FEEDBACK_MAX = 20_000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/chat" && request.method === "POST") return handleChat(request, env);
    if (pathname === "/api/feedback" && request.method === "POST") return feedback(request, env);
    if (pathname === "/api/health") {
      const pages = await env.DB.prepare("SELECT value FROM meta WHERE key = 'pages'").first<{ value: string }>();
      return Response.json({
        checked: await checkedDate(env.DB),
        pages: Number(pages?.value ?? 0),
        model: `${env.MODEL_PROVIDER}:${env.MODEL_ID}`,
      });
    }
    if (pathname.startsWith("/api/")) return Response.json({ error: "Not found." }, { status: 404 });
    if (pathname.startsWith("/models/") && pathname.endsWith(".onnx")) return gzipped(request, env);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function feedback(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  if (!(await env.CHAT_LIMIT.limit({ key: `feedback:${ip}` })).success) {
    return Response.json({ error: "Too many requests." }, { status: 429 });
  }
  const text = await request.text();
  if (text.length > FEEDBACK_MAX) return Response.json({ error: "Feedback is too long." }, { status: 413 });
  let body: { rating?: unknown; question?: unknown; answer?: unknown; sources?: unknown; comment?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Malformed request." }, { status: 400 });
  }
  if ((body.rating !== "up" && body.rating !== "down") || typeof body.question !== "string" || typeof body.answer !== "string") {
    return Response.json({ error: "Malformed feedback." }, { status: 400 });
  }
  await env.DB.prepare(
    "INSERT INTO feedback (created, rating, question, answer, sources, comment, model) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      new Date().toISOString(),
      body.rating,
      body.question.slice(0, 8000),
      body.answer.slice(0, 8000),
      JSON.stringify(Array.isArray(body.sources) ? body.sources.slice(0, 20) : []),
      typeof body.comment === "string" ? body.comment.slice(0, 2000) : "",
      `${env.MODEL_PROVIDER}:${env.MODEL_ID}`,
    )
    .run();
  return Response.json({ ok: true });
}

// Cloudflare doesn't compress .onnx files, so scripts/build.ts stores the model as <name>.onnx.gz
// and this serves those bytes as-is with Content-Encoding: gzip, which every browser accepts
// (1.45 MB becomes 1.2 MB on a student's first visit).
async function gzipped(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  url.pathname += ".gz";
  const asset = await env.ASSETS.fetch(new Request(url, request));
  if (!asset.ok) return asset;
  const headers = new Headers(asset.headers);
  headers.set("content-type", "application/octet-stream");
  headers.set("content-encoding", "gzip");
  return new Response(asset.body, { headers, encodeBody: "manual" });
}
