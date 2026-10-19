// Stateless, signed history (America.gov's design): the server keeps no conversations.
// The browser holds the chat and sends it back each turn; every assistant message
// carries an HMAC over the conversation up to and including it, so an earlier answer
// can't be rewritten client-side and replayed to the model as if RiverGuide said it.
// Only text is replayed to the model; tool results are re-fetched, never trusted from the client.

import type { UIMessage } from "ai";

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

export function textOf(message: Pick<UIMessage, "parts">): string {
  return message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}

export function turnsOf(messages: UIMessage[]): Turn[] {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as Turn["role"], text: textOf(m) }));
}

const encoder = new TextEncoder();

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function canonical(turns: Turn[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encoder.encode(JSON.stringify(turns.map((t) => [t.role, t.text]))));
}

export async function sign(secret: string, turns: Turn[]): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await key(secret), canonical(turns));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verify(secret: string, turns: Turn[], signature: unknown): Promise<boolean> {
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const bytes = new Uint8Array(signature.match(/../g)!.map((h) => parseInt(h, 16)));
  return crypto.subtle.verify("HMAC", await key(secret), bytes, canonical(turns));
}

export type Checked =
  | { ok: true; history: Turn[]; question: string }
  | { ok: false; status: number; error: string };

/** Validate an incoming chat: signed history, then exactly one new user message. */
export async function checkHistory(secret: string, messages: unknown, maxTurns: number, maxChars: number): Promise<Checked> {
  if (!Array.isArray(messages) || messages.length === 0) return { ok: false, status: 400, error: "No message." };
  if (messages.length > maxTurns) return { ok: false, status: 400, error: "This chat is long. Start a new chat to keep going." };
  const msgs = messages as UIMessage[];
  if (!msgs.every((m) => m && Array.isArray(m.parts) && (m.role === "user" || m.role === "assistant"))) {
    return { ok: false, status: 400, error: "Malformed chat." };
  }
  const last = msgs[msgs.length - 1];
  if (last.role !== "user") return { ok: false, status: 400, error: "The last message must be yours." };
  const question = textOf(last).trim();
  if (!question) return { ok: false, status: 400, error: "Type a question first." };
  if (question.length > maxChars) return { ok: false, status: 413, error: `Messages are limited to ${maxChars} characters.` };

  const prior = msgs.slice(0, -1);
  if (prior.length) {
    const lastAssistant = prior.map((m) => m.role).lastIndexOf("assistant");
    // Everything before the new question must be covered by the last answer's signature.
    if (lastAssistant !== prior.length - 1) return { ok: false, status: 400, error: "This chat can't be continued. Start a new chat." };
    const sig = (prior[lastAssistant].metadata as { sig?: unknown } | undefined)?.sig;
    if (!(await verify(secret, turnsOf(prior), sig))) {
      return { ok: false, status: 400, error: "This chat can't be continued. Start a new chat." };
    }
  }
  return { ok: true, history: turnsOf(prior), question };
}
