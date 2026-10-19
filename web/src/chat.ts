// POST /api/chat: America.gov's design at College scale.
// A prompt, three tools over D1, a two-hour answer cache, signed stateless history,
// and a link guard. Logs record outcomes and timing only, never what students type.

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  isStepCount,
  streamText,
  tool,
  type LanguageModel,
  type ModelMessage,
  type UIMessageStreamWriter,
} from "ai";
import { z } from "zod";
import PROMPT from "../../prompt.md";
import { checkHistory, sign, type Turn } from "./history";
import { evidenceLinks, LinkGuard } from "./linkguard";
import { FilterError, checkedDate, isIndexedUrl, normalizeUrl, readPage, search, searchSections } from "./search";

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  CHAT_LIMIT: RateLimit;
  ASSETS: Fetcher;
  HISTORY_SECRET: string;
  MODEL_PROVIDER: string; // "ollama" | "xai" | "anthropic"
  MODEL_ID: string;
  OLLAMA_URL?: string;
  OLLAMA_API_KEY?: string; // the model gateway's bearer token (deploy/omarchy/model-gateway.ts)
  XAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  SECTIONS_MAX_AGE_HOURS?: string;
}

const MAX_CHARS = 8000;
const MAX_MESSAGES = 40;
const MAX_STEPS = 8;
const ANSWER_TTL_SECONDS = 2 * 60 * 60;
const UNAVAILABLE = "RiverGuide is unavailable right now. Please try again in a few minutes.";

// Shown before any answer; the model is also told to lead with it.
const CRISIS =
  /\b(suicid\w*|kill(ing)? myself|end (my life|it all)|want(ing)? to die|self[- ]?harm\w*|hurt(ing)? myself|cut(ting)? myself|overdos\w*|no reason to live|matarme|quiero morir(me)?|hacerme da[ñn]o)\b/i;

const FOLLOWUP_INSTRUCTIONS =
  "Suggest three short follow-up questions a student might ask Indian River State College's advisor next, " +
  "based on this exchange. Write them in the student's language, each under 70 characters, one per line, " +
  "with no numbering or extra text.";

export function chatModel(env: Env): LanguageModel {
  switch (env.MODEL_PROVIDER) {
    case "xai":
      return createXai({ apiKey: env.XAI_API_KEY })(env.MODEL_ID);
    case "anthropic":
      return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(env.MODEL_ID);
    default:
      return createOpenAICompatible({
        name: "ollama",
        baseURL: env.OLLAMA_URL ?? "http://127.0.0.1:11434/v1",
        apiKey: env.OLLAMA_API_KEY,
      }).chatModel(env.MODEL_ID);
  }
}

function today(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date());
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeQuestion(q: string): string {
  return q.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim().replace(/[\s?.!]+$/, "");
}

interface Source {
  url: string;
  title: string;
}
interface ToolUse {
  name: string;
  input: unknown;
}
interface CachedAnswer {
  text: string;
  sources: Source[];
  followups: string[];
  tools: ToolUse[];
}
type Answer = CachedAnswer & { uncacheable?: boolean; linksRemoved?: number };

export async function handleChat(request: Request, env: Env): Promise<Response> {
  const started = Date.now();
  if ((env.HISTORY_SECRET ?? "").length < 32) {
    console.log(JSON.stringify({ event: "chat_error", error: "HISTORY_SECRET is not set" }));
    return Response.json({ error: UNAVAILABLE }, { status: 503 });
  }
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  if (!(await env.CHAT_LIMIT.limit({ key: ip })).success) {
    return Response.json({ error: "Too many questions at once. Wait a minute and try again." }, { status: 429 });
  }
  let body: { messages?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Malformed request." }, { status: 400 });
  }
  const checked = await checkHistory(env.HISTORY_SECRET, body.messages, MAX_MESSAGES, MAX_CHARS);
  if (!checked.ok) return Response.json({ error: checked.error }, { status: checked.status });
  const { history, question } = checked;

  const corpusDate = await checkedDate(env.DB);
  const date = today();
  const instructions = `${PROMPT}\n\nToday is ${date} (Eastern Time).`;
  const crisis = CRISIS.test(question);
  const modelName = `${env.MODEL_PROVIDER}:${env.MODEL_ID}`;
  // Evals bypass the cache so every run measures the model. (It saves nothing a caller couldn't
  // get by rewording the question.)
  const bypass = request.headers.get("x-riverguide-cache") === "bypass";
  // The cache holds first questions only: a follow-up like "and for spring?" depends on the chat.
  // Asking the chat's first question again is the exception: replay what this chat already got.
  const repeatOfFirst = history.length > 0 && normalizeQuestion(history[0].text) === normalizeQuestion(question);
  const cacheKey =
    (history.length === 0 || repeatOfFirst) && !crisis && !bypass
      ? `answer:${await sha256([await sha256(PROMPT), corpusDate, date, modelName, normalizeQuestion(question)].join("|"))}`
      : null;

  const stream = createUIMessageStream({
    onError: (error) => {
      console.log(JSON.stringify({ event: "chat_error", error: String(error).slice(0, 300), model: modelName }));
      return UNAVAILABLE;
    },
    execute: async ({ writer }) => {
      writer.write({ type: "start" });
      if (crisis) writer.write({ type: "data-crisis", id: "crisis", data: { show: true } });

      const cached = cacheKey ? await env.CACHE.get<CachedAnswer>(cacheKey, "json") : null;
      const answer: Answer = cached ?? (await answerQuestion(env, writer, instructions, history, question, crisis));
      if (cached) replay(writer, cached);

      writer.write({ type: "data-sources", id: "sources", data: { sources: answer.sources } });
      writer.write({ type: "data-followups", id: "followups", data: { questions: answer.followups } });
      const turns: Turn[] = [...history, { role: "user", text: question }, { role: "assistant", text: answer.text }];
      writer.write({ type: "message-metadata", messageMetadata: { sig: await sign(env.HISTORY_SECRET, turns) } });
      writer.write({ type: "finish" });

      if (cacheKey && history.length === 0 && !cached && answer.text && !answer.uncacheable) {
        const value: CachedAnswer = { text: answer.text, sources: answer.sources, followups: answer.followups, tools: answer.tools };
        await env.CACHE.put(cacheKey, JSON.stringify(value), { expirationTtl: ANSWER_TTL_SECONDS });
      }
      console.log(
        JSON.stringify({
          event: "chat",
          ms: Date.now() - started,
          cache: cacheKey ? (cached ? (repeatOfFirst ? "hit-repeat" : "hit") : "miss") : "skip",
          turn: history.length / 2 + 1,
          tools: answer.tools.map((t) => t.name),
          links_removed: answer.linksRemoved ?? 0,
          crisis,
          model: modelName,
        }),
      );
    },
  });
  return createUIMessageStreamResponse({ stream });
}

function replay(writer: UIMessageStreamWriter, cached: CachedAnswer) {
  for (const [i, t] of cached.tools.entries()) {
    writer.write({ type: "data-tool", id: `cached-${i}`, data: { ...t, cached: true } });
  }
  writer.write({ type: "text-start", id: "cached" });
  writer.write({ type: "text-delta", id: "cached", delta: cached.text });
  writer.write({ type: "text-end", id: "cached" });
}

async function answerQuestion(
  env: Env,
  writer: UIMessageStreamWriter,
  instructions: string,
  history: Turn[],
  question: string,
  crisis: boolean,
): Promise<Answer> {
  const db = env.DB;
  const titles = new Map<string, string>(); // normalized url -> page title, from tool results
  const evidence = new Set<string>(); // links and addresses seen in tool results or earlier answers
  const remember = (text: string) => {
    for (const link of evidenceLinks(text)) evidence.add(normalizeUrl(link) ?? link.toLowerCase());
  };
  history.forEach((t) => t.role === "assistant" && remember(t.text));
  const record = (output: unknown) => {
    remember(JSON.stringify(output));
    const pages = (output as { results?: Source[] }).results ?? [output as Source];
    for (const p of pages) {
      const key = p?.url && normalizeUrl(p.url);
      if (key && p.title) titles.set(key, p.title);
    }
    return output;
  };

  const tools = {
    search: tool({
      description:
        "Search Indian River State College's official website (irsc.edu) and College catalog.\n\n" +
        "Use for anything about the College: admissions, the academic calendar and deadlines, tuition and fees, " +
        "financial aid, programs and requirements, courses (credits, prerequisites), policies, offices and contacts, " +
        'campus services, and how-to steps. Write short keyword queries, for example "drop deadline fall 2026", ' +
        '"ENC 1101", or "student help desk phone". If the results miss, search again with other words: the official ' +
        "name, a spelled-out acronym, or the office that owns the topic. Run several searches at once when a question " +
        "has several parts.\n\nEach result has the page title, url, the date its content last changed (updated), " +
        "and an excerpt. Use read_page for the whole page.",
      inputSchema: z.object({ query: z.string(), limit: z.number().int().nullish() }),
      execute: async ({ query, limit }) => record(await search(db, query, limit ?? 8)),
    }),
    read_page: tool({
      description:
        "Read the full text of an official College page, by its url from search results.\n\n" +
        "Use when an excerpt is cut off or you need the rest of a table, list, or policy. Long pages come in " +
        "parts: pass next_start as start to keep reading.",
      inputSchema: z.object({ url: z.string(), start: z.number().int().nullish() }),
      execute: async ({ url, start }) => record(await readPage(db, url, start ?? 0)),
    }),
    search_sections: tool({
      description:
        "Public class listings for one term from the latest schedule snapshot.\n\n" +
        "Answers whether a course is offered in a term, online/hybrid/in person, campus, CRN, meeting days and " +
        'times, and reported open/full status. term is required, e.g. "Fall 2026". Filter with course_code ' +
        '("ENC 1101"), keyword, delivery (online, online_async, online_live, hybrid, in_person), campus (Massey, ' +
        "Pruitt, Chastain, Mueller, Dixon Hendry, Blackburn, River Online), or open_only.\n\n" +
        "Results are a dated snapshot, not live registration. Zero matches means no public match in that " +
        "snapshot, not that the course is never offered. Not for a student's own schedule, and not for whether a " +
        "whole program is online (use the program's catalog page for that).",
      inputSchema: z.object({
        term: z.string(),
        course_code: z.string().nullish(),
        crn: z.string().nullish(),
        keyword: z.string().nullish(),
        delivery: z.string().nullish(),
        campus: z.string().nullish(),
        open_only: z.boolean().nullish(),
        limit: z.number().int().nullish(),
      }),
      execute: async (input) => {
        try {
          return record(
            await searchSections(db, { ...input, open_only: input.open_only ?? false }, Number(env.SECTIONS_MAX_AGE_HOURS ?? 24)),
          );
        } catch (error) {
          if (error instanceof FilterError) return { error: error.message };
          throw error;
        }
      },
    }),
  };

  const messages: ModelMessage[] = [
    ...history.map((t) => ({ role: t.role, content: t.text }) as ModelMessage),
    { role: "user", content: question },
  ];
  if (crisis) {
    messages.push({
      role: "system",
      content: "The student may be in crisis. Lead with: call or text 988 (Suicide & Crisis Lifeline), or call 911 if in danger now.",
    });
  }

  const guard = new LinkGuard(async (url) => {
    const key = normalizeUrl(url) ?? url.toLowerCase();
    if (evidence.has(key)) return true;
    return /^https?:/i.test(url) && (await isIndexedUrl(db, url));
  });
  const used: ToolUse[] = [];
  let text = "";
  let finishReason = "";
  const result = streamText({
    model: chatModel(env),
    instructions,
    messages,
    allowSystemInMessages: true,
    tools,
    stopWhen: isStepCount(MAX_STEPS),
    maxOutputTokens: 4000,
  });
  const emit = (id: string, delta: string) => {
    if (!delta) return;
    writer.write({ type: "text-delta", id, delta });
    text += delta;
  };
  for await (const part of result.stream) {
    switch (part.type) {
      case "tool-call":
        used.push({ name: part.toolName, input: part.input });
        writer.write({ type: "data-tool", id: part.toolCallId, data: { name: part.toolName, input: part.input } });
        break;
      case "text-start":
        writer.write({ type: "text-start", id: part.id });
        // A model that writes before searching ("Let me check…") resumes in a new text part; keep
        // the two from running together ("…fall under.In-state…").
        if (text && !text.endsWith("\n")) emit(part.id, "\n\n");
        break;
      case "text-delta":
        emit(part.id, await guard.push(part.text));
        break;
      case "text-end":
        emit(part.id, await guard.flush());
        writer.write({ type: "text-end", id: part.id });
        break;
      case "finish":
        finishReason = part.finishReason;
        break;
      case "error":
        throw part.error;
    }
  }

  const sources: Source[] = [];
  const seen = new Set<string>();
  for (const url of guard.linked) {
    const key = normalizeUrl(url);
    if (!key || seen.has(key) || !/^https?:/i.test(url)) continue;
    seen.add(key);
    sources.push({ url, title: titles.get(key) ?? url });
  }
  const followups = crisis || !text ? [] : await suggestFollowups(env, question, text);
  return {
    text,
    sources,
    followups,
    tools: used,
    linksRemoved: guard.removed,
    uncacheable: finishReason !== "stop" || guard.removed > 0,
  };
}

async function suggestFollowups(env: Env, question: string, answer: string): Promise<string[]> {
  try {
    const { text } = await generateText({
      model: chatModel(env),
      instructions: FOLLOWUP_INSTRUCTIONS,
      prompt: `Student: ${question}\n\nAdvisor: ${answer}`,
      maxOutputTokens: 400,
      // Three short questions need no reasoning; with it, Qwen spends the budget thinking (0.6 s vs 2.4 s+).
      providerOptions: { ollama: { reasoningEffort: "none" } },
    });
    return text
      .split("\n")
      .map((line) => line.replace(/^[\s\-*\d.)]+/, "").trim())
      .filter((line) => line.length > 0 && line.length <= 120 && !line.endsWith(":"))
      .slice(0, 3);
  } catch {
    return [];
  }
}
