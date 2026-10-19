// RiverGuide's chat page. No framework: the static markup lives in index.html and this file
// renders the thread. Each turn POSTs the whole chat to /api/chat (the server keeps nothing)
// and reads the answer back as an AI SDK UI message stream (SSE).
//
// <body data-mode="welcome|chat"> switches the layout; data-busy marks a question in flight, and
// data-docked marks the welcome page scrolled past its photo card (the question box follows).

import { Marked, type Tokens } from "marked";
import { EXAMPLES } from "./examples";
import type { Highlight } from "./pii";
import { createTypeahead, type Entry, type Suggestion } from "./typeahead";

// Rampart Edge's client (its validators and allowlist, about 190 KB) loads after the page.
const pii = () => import("./pii");

const MAX_CHARS = 8000;

interface Source {
  url: string;
  title: string;
}
interface Tool {
  name: string;
  input: Record<string, unknown>;
}
interface Answer {
  text: string;
  sig?: string;
  sources: Source[];
  followups: string[];
  tools: Tool[];
  crisis: boolean;
}
type Turn = { id: string; role: "user"; text: string } | ({ id: string; role: "assistant" } & Answer);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const body = document.body;
const thread = $<HTMLOListElement>("thread");
const form = $<HTMLFormElement>("form");
const input = $<HTMLTextAreaElement>("question");
const askButton = $<HTMLButtonElement>("ask");
const newChatButton = $<HTMLButtonElement>("new-chat");
const errorBox = $("error");
const retryButton = $<HTMLButtonElement>("retry");
const blockedBox = $("blocked");
const charsLeft = $("chars-left");

let turns: Turn[] = [];
let busy = false;
let controller: AbortController | null = null;

// ---------- markdown ----------

// Raw HTML from the model is shown as text; links open in a new tab and only https,
// mailto, and tel survive (the server's link guard already checked every URL).
const markdown = new Marked({
  gfm: true,
  renderer: {
    html: (token: Tokens.HTML | Tokens.Tag) => escapeHtml(token.text),
    image: (token: Tokens.Image) => escapeHtml(token.text),
    link(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: Tokens.Link) {
      const label = this.parser.parseInline(token.tokens);
      if (!/^(https:|mailto:|tel:)/i.test(token.href)) return label;
      return `<a href="${escapeHtml(token.href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    },
  },
});

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const ICONS = {
  up: '<path d="M7 10v10H4V10h3Zm0 0 4-7c1.7 0 2.8 1.4 2.4 3L13 9h5.3c1.3 0 2.2 1.2 1.9 2.4l-1.7 7A2 2 0 0 1 16.6 20H7"/>',
  down: '<path d="M17 14V4h3v10h-3Zm0 0-4 7c-1.7 0-2.8-1.4-2.4-3L11 15H5.7c-1.3 0-2.2-1.2-1.9-2.4l1.7-7A2 2 0 0 1 7.4 4H17"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  check: '<path d="m5 12 4.5 4.5L19 7"/>',
};
function icon(name: keyof typeof ICONS): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
}

// ---------- asking ----------

// Rampart Edge checks a question in milliseconds once its model has loaded, but until then (a
// second or more, on a first visit) the check waits. After this long the chat opens anyway, so the
// student isn't left on the landing page; nothing is sent until the check passes. (Opening at once
// would flash the chat open and shut whenever a question is blocked.)
const OPEN_CHAT_AFTER_MS = 150;

// `suggested` marks a question RiverGuide offered (a starter or "Ask next" chip, or the typeahead's).
// Those are its own words, not the student's, so they go straight out; only what the student types
// waits for Rampart Edge.
async function ask(raw: string, suggested = false) {
  const question = raw.trim();
  if (!question || busy || question.length > MAX_CHARS) return;
  closeSuggestions();
  setBusy(true);
  hideError();
  blockedBox.hidden = true;
  const { signal } = (controller = new AbortController());
  let view: AnswerView | undefined;
  try {
    if (!suggested) {
      const check = Promise.race([pii().then((p) => p.findPii(question)), whenAborted(signal)]);
      if (!(await settlesWithin(check, OPEN_CHAT_AFTER_MS))) view = showQuestion(question);
      const { blocked, spans, reason, model } = await check;
      $("pii-limited").hidden = model;
      if (blocked) {
        takeBack(question, view);
        showBlocked(question, spans, reason);
        input.focus();
        return;
      }
    }
    view ??= showQuestion(question);
    turns.push({ id: crypto.randomUUID(), role: "user", text: question });
    await answer(view, signal);
  } catch (error) {
    if ((error as Error).name === "AbortError") return; // "New chat" has cleared the thread
    if (turns.at(-1)?.role === "user") turns.pop();
    takeBack(question, view);
    const message = error instanceof ChatError ? error.message : "RiverGuide is unavailable right now. Please try again.";
    showError(message, error instanceof ChatError ? error.retry : true);
  } finally {
    controller = null;
    setBusy(false);
  }
}

async function answer(view: AnswerView, signal: AbortSignal) {
  const answer: Answer = { text: "", sources: [], followups: [], tools: [], crisis: false };
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: turns.map(toUIMessage) }),
    signal,
  });
  if (!response.ok || !response.body) {
    const error = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ChatError(error.error ?? "Something went wrong. Try again.", response.status !== 400);
  }
  for await (const part of readStream(response.body)) {
    apply(answer, part);
    view.update(answer, true);
  }
  if (!answer.text) throw new ChatError("RiverGuide didn’t answer. Try again.", true);
  turns.push({ id: crypto.randomUUID(), role: "assistant", ...answer });
  view.update(answer, false, turns.length - 1);
}

// The question moves from the box into the chat, with a place for its answer.
function showQuestion(question: string): AnswerView {
  input.value = "";
  resize();
  updateCharsLeft();
  renderUser(question);
  return renderAssistantShell();
}

// The question leaves the chat and goes back in the box, to edit or try again.
function takeBack(question: string, view: AnswerView | undefined) {
  if (view) {
    view.remove();
    thread.lastElementChild?.remove(); // the question
    if (!turns.length) setMode("welcome");
  }
  input.value = question;
  resize();
  updateCharsLeft();
}

function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);
}

function whenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
}

class ChatError extends Error {
  constructor(message: string, readonly retry: boolean) {
    super(message);
  }
}

function toUIMessage(turn: Turn) {
  return turn.role === "user"
    ? { id: turn.id, role: "user", parts: [{ type: "text", text: turn.text }] }
    : { id: turn.id, role: "assistant", metadata: { sig: turn.sig }, parts: [{ type: "text", text: turn.text }] };
}

// ---------- the UI message stream (SSE "data: {json}" events) ----------

type Part = { type: string; [key: string]: unknown };

async function* readStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<Part> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      for (const line of event.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") return;
        yield JSON.parse(data) as Part;
      }
    }
  }
}

function apply(answer: Answer, part: Part) {
  const data = part.data as Record<string, unknown> | undefined;
  switch (part.type) {
    case "text-delta":
      answer.text += String(part.delta ?? "");
      break;
    case "data-tool":
      answer.tools.push(data as unknown as Tool);
      break;
    case "data-sources":
      answer.sources = (data?.sources as Source[]) ?? [];
      break;
    case "data-followups":
      answer.followups = (data?.questions as string[]) ?? [];
      break;
    case "data-crisis":
      answer.crisis = Boolean(data?.show);
      break;
    case "message-metadata":
      answer.sig = (part.messageMetadata as { sig?: string } | undefined)?.sig;
      break;
    case "error":
      throw new ChatError(String(part.errorText ?? "Something went wrong. Try again."), true);
  }
}

// ---------- rendering ----------

function setMode(mode: "welcome" | "chat") {
  body.dataset.mode = mode;
  newChatButton.hidden = mode === "welcome";
  input.placeholder = mode === "chat" ? "Ask a follow-up…" : `Try “${EXAMPLES[0]}”`;
}

function renderUser(text: string) {
  setMode("chat");
  const item = el("li", "rg-user");
  item.append(el("p", undefined, text));
  thread.append(item);
}

function toolQuery(tool: Tool): string {
  const input = tool.input ?? {};
  if (tool.name === "search") return String(input.query ?? "");
  if (tool.name === "read_page") return "reading a page";
  if (tool.name === "search_sections") return `class listings${input.term ? `, ${input.term}` : ""}${input.course_code ? `, ${input.course_code}` : ""}`;
  return "official sources";
}

type AnswerView = ReturnType<typeof renderAssistantShell>;

function renderAssistantShell() {
  const item = el("li", "rg-answer");
  const status = el("p", "rg-status");
  status.setAttribute("role", "status");
  const label = el("span", "rg-status__label", "Checking the College’s pages");
  const queries = el("span", "rg-status__queries");
  status.append(label, queries);
  const crisis = crisisCard();
  crisis.hidden = true;
  const content = el("div", "rg-markdown");
  const after = el("div", "rg-after");
  item.append(crisis, status, content, after);
  thread.append(item);
  scrollDown();
  let frame = 0;
  let shownTools = 0;

  return {
    update(answer: Answer, streaming: boolean, index?: number) {
      crisis.hidden = !answer.crisis;
      status.hidden = Boolean(answer.text) || !streaming;
      for (; shownTools < answer.tools.length; shownTools++) {
        queries.append(el("span", "rg-query", toolQuery(answer.tools[shownTools])));
      }
      cancelAnimationFrame(frame);
      const draw = () => {
        content.innerHTML = markdown.parse(answer.text) as string;
        if (!streaming && index !== undefined) after.replaceChildren(...extras(answer, index));
        scrollDown();
      };
      if (streaming) frame = requestAnimationFrame(draw);
      else draw();
    },
    remove() {
      item.remove();
    },
  };
}

function crisisCard(): HTMLElement {
  const card = el("div", "rg-crisis");
  card.setAttribute("role", "alert");
  card.append(el("p", "rg-crisis__title", "You don’t have to go through this alone."));
  const p = el("p");
  p.innerHTML =
    'Call or text <a href="tel:988">988</a> (Suicide &amp; Crisis Lifeline), any time, in English or Spanish. ' +
    'Veterans, press 1. If you are in danger right now, call <a href="tel:911">911</a>.';
  card.append(p);
  return card;
}

// "Catalog > Academic Calendar > Fall 2026" reads best as its last two crumbs.
function sourceTitle(title: string): string {
  return title.split(" > ").filter((c) => c !== "Catalog").slice(-2).join(" › ");
}

function extras(answer: Answer, index: number): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  if (answer.sources.length) {
    const list = el("ul", "rg-sources");
    list.setAttribute("aria-label", "Sources");
    for (const s of answer.sources) {
      const a = el("a");
      a.href = s.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.append(el("span", "rg-source-host", new URL(s.url).host.replace(/^www\./, "")));
      a.append(el("span", "rg-source-title", sourceTitle(s.title)));
      const li = el("li");
      li.append(a);
      list.append(li);
    }
    nodes.push(list);
  }

  const meta = el("div", "rg-meta");
  meta.setAttribute("role", "group");
  meta.setAttribute("aria-label", "This answer");
  const rateUp = iconButton("up", "Helpful");
  const rateDown = iconButton("down", "Not helpful");
  const copy = iconButton("copy", "Copy answer");
  for (const [button, rating] of [[rateUp, "up"], [rateDown, "down"]] as const) {
    button.addEventListener("click", () => {
      rateUp.remove();
      rateDown.remove();
      meta.prepend(el("span", undefined, "Thanks for the feedback."));
      void rate(index, rating);
    });
  }
  copy.addEventListener("click", async () => {
    await navigator.clipboard?.writeText(answer.text).catch(() => undefined);
    copy.innerHTML = icon("check");
    setTimeout(() => (copy.innerHTML = icon("copy")), 1500);
  });
  meta.append(rateUp, rateDown, copy);
  const searches = answer.tools.filter((t) => t.name === "search").map((t) => `“${toolQuery(t)}”`);
  if (searches.length) meta.append(el("span", "rg-meta__tools", `Searched ${searches.join(", ")}`));
  nodes.push(meta);

  if (answer.followups.length) {
    nodes.push(el("p", "rg-next-label", "Ask next"));
    const list = el("ul", "rg-followups");
    for (const q of answer.followups) {
      const button = el("button", "rg-chip", q);
      button.type = "button";
      button.addEventListener("click", () => void ask(q, true));
      const li = el("li");
      li.append(button);
      list.append(li);
    }
    nodes.push(list);
  }
  return nodes;
}

function iconButton(name: keyof typeof ICONS, label: string): HTMLButtonElement {
  const button = el("button", "rg-icon-button");
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.innerHTML = icon(name);
  return button;
}

async function rate(index: number, rating: "up" | "down") {
  const answerTurn = turns[index];
  const questionTurn = turns[index - 1];
  if (answerTurn?.role !== "assistant" || questionTurn?.role !== "user") return;
  await fetch("/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rating, question: questionTurn.text, answer: answerTurn.text, sources: answerTurn.sources }),
  }).catch(() => undefined);
}

function showBlocked(text: string, spans: Highlight[], reason: string) {
  $("blocked-reason").textContent = reason;
  const target = $("blocked-text");
  target.replaceChildren();
  let at = 0;
  for (const span of spans) {
    if (span.start < at) continue;
    target.append(text.slice(at, span.start), el("mark", undefined, text.slice(span.start, span.end)));
    at = span.end;
  }
  target.append(text.slice(at));
  target.hidden = !spans.length; // the model can block without marking anything
  blockedBox.hidden = false;
}

function showError(message: string, retry: boolean) {
  $("error-text").textContent = message;
  retryButton.hidden = !retry;
  errorBox.hidden = false;
}

function hideError() {
  errorBox.hidden = true;
}

function setBusy(value: boolean) {
  busy = value;
  if (value) body.dataset.busy = "";
  else delete body.dataset.busy;
  askButton.setAttribute("aria-label", value ? "Working" : "Ask");
  for (const chip of document.querySelectorAll<HTMLButtonElement>(".rg-chip")) chip.disabled = value;
  syncSend();
}

function syncSend() {
  askButton.disabled = busy || !input.value.trim();
}

function scrollDown() {
  if (body.dataset.mode === "chat") window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
}

function updateCharsLeft() {
  const left = MAX_CHARS - input.value.length;
  charsLeft.hidden = left > 500;
  charsLeft.textContent = `${left} characters left`;
}

function resize() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  syncSend();
}

// Rotate example questions in the empty box, like a hint that changes.
function rotateExamples() {
  let i = 0;
  const show = () => {
    if (body.dataset.mode === "welcome") input.placeholder = `Try “${EXAMPLES[i % EXAMPLES.length]}”`;
  };
  show();
  setInterval(() => {
    if (input.value || document.activeElement === input || body.dataset.mode !== "welcome") return;
    input.classList.add("rg-fading");
    setTimeout(() => {
      i++;
      show();
      input.classList.remove("rg-fading");
    }, 300);
  }, 3500);
}

// ---------- typeahead ----------

// On the welcome page, up to three questions from the College's pages as the student types their
// first question (typeahead.ts); the chat has its own follow-ups. The dictionary loads on the first
// keystroke and matching runs here, so nothing typed is sent. Tab puts the highlighted question in
// the box; a click asks it, and so does Enter once the student has moved to one with the arrow keys
// (otherwise Enter asks what they typed). Escape closes the list. Suggestions are RiverGuide's own
// words, so like the chips they go straight out.
const suggestionList = $<HTMLUListElement>("suggestions");
let suggest: ((text: string) => Suggestion[]) | null = null;
let dictionary: Promise<void> | null = null;
let shown: Suggestion[] = [];
let active = 0;
let picked = false;

function showSuggestions() {
  if (body.dataset.mode !== "welcome") {
    closeSuggestions();
    return;
  }
  if (!suggest) {
    if (input.value.trim()) {
      dictionary ??= fetch("/questions.json")
        .then((response) => response.json() as Promise<{ entries: Entry[] }>)
        .then(({ entries }) => {
          suggest = createTypeahead(entries);
          showSuggestions();
        })
        .catch((error) => console.warn("[riverguide] suggestions are unavailable:", error));
    }
    return;
  }
  shown = busy || document.activeElement !== input ? [] : suggest(input.value);
  picked = false;
  suggestionList.replaceChildren(
    ...shown.map((s, i) => {
      const option = el("button", "rg-suggestion");
      option.type = "button";
      option.id = `suggestion-${i}`;
      option.tabIndex = -1;
      option.setAttribute("role", "option");
      option.append(s.text.slice(0, s.typed[0]), el("span", "rg-suggestion__typed", s.text.slice(...s.typed)), s.text.slice(s.typed[1]));
      option.addEventListener("pointerdown", (event) => event.preventDefault()); // keep the focus in the box
      option.addEventListener("pointermove", () => highlight(i));
      option.addEventListener("click", () => void ask(s.text, true));
      const item = el("li");
      item.setAttribute("role", "presentation");
      item.append(option);
      return item;
    }),
  );
  suggestionList.hidden = !shown.length;
  input.setAttribute("aria-expanded", String(shown.length > 0));
  highlight(0);
}

function highlight(index: number) {
  active = index;
  for (const [i, option] of suggestionList.querySelectorAll("[role=option]").entries()) {
    option.setAttribute("aria-selected", String(i === index));
  }
  if (shown.length) input.setAttribute("aria-activedescendant", `suggestion-${index}`);
  else input.removeAttribute("aria-activedescendant");
}

function closeSuggestions() {
  if (!shown.length) return;
  shown = [];
  suggestionList.replaceChildren();
  suggestionList.hidden = true;
  input.setAttribute("aria-expanded", "false");
  highlight(0);
}

// ---------- the welcome page: photos, the docked question box, the statement ----------

const SLIDE_MS = 6500;

// The photos cross-fade every few seconds, but not while the student is typing, and not at all
// with reduced motion unless they press play. A photo is shown only once it has decoded.
function slideshow() {
  const slides = [...document.querySelectorAll<HTMLImageElement>(".rg-slide")];
  const pause = $<HTMLButtonElement>("slide-pause");
  let index = 0;
  let wanted = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function show(next: number) {
    const target = (next + slides.length) % slides.length;
    wanted = target;
    slides[target].loading = "eager";
    await slides[target].decode().catch(() => undefined);
    if (wanted !== target || target === index) return;
    slides[index].removeAttribute("data-active");
    slides[index].setAttribute("aria-hidden", "true");
    slides[target].setAttribute("data-active", "");
    slides[target].removeAttribute("aria-hidden");
    index = target;
  }
  function play(on: boolean) {
    pause.dataset.playing = String(on);
    pause.setAttribute("aria-label", on ? "Pause photos" : "Play photos");
    clearInterval(timer);
    if (!on) return;
    timer = setInterval(() => {
      if (body.dataset.mode === "welcome" && document.activeElement !== input && !document.hidden) void show(index + 1);
    }, SLIDE_MS);
  }
  const step = (by: number) => {
    void show(index + by);
    if (pause.dataset.playing === "true") play(true); // a full interval before the next change
  };
  $("slide-prev").addEventListener("click", () => step(-1));
  $("slide-next").addEventListener("click", () => step(1));
  pause.addEventListener("click", () => play(pause.dataset.playing !== "true"));
  play(!matchMedia("(prefers-reduced-motion: reduce)").matches);
}

// Once the question box's place on the photo card scrolls out of view, the box docks to the
// bottom of the window, so it's always one tap away.
function dockOnScroll() {
  new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting && entry.boundingClientRect.bottom < 0) body.dataset.docked = "";
    else delete body.dataset.docked;
  }).observe($("dock-anchor"));
}

// Wrap each word of the statement so CSS can bring it into focus as it scrolls up.
function splitWords(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const text of texts) {
    const parts = text.data.split(/(\s+)/).filter(Boolean);
    text.replaceWith(...parts.map((part) => (/^\s+$/.test(part) ? part : el("span", "rg-word", part))));
  }
  for (const icon of root.querySelectorAll(".rg-inline")) icon.classList.add("rg-word");
}

// The rows of page names loop seamlessly: each row holds its names twice and slides by half.
function loopMarquees() {
  for (const row of document.querySelectorAll(".rg-marquee__row")) {
    row.append(...[...row.children].map((child) => child.cloneNode(true)));
  }
}

// ---------- wiring ----------

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void ask(input.value);
});
input.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (shown.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    event.preventDefault();
    picked = true;
    highlight((active + (event.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
  } else if (shown.length && event.key === "Tab" && !event.shiftKey) {
    event.preventDefault();
    input.value = `${shown[active].text} `;
    input.dispatchEvent(new Event("input"));
  } else if (shown.length && event.key === "Escape") {
    event.preventDefault();
    closeSuggestions();
  } else if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (picked && shown.length) void ask(shown[active].text, true);
    else void ask(input.value);
  }
});
input.addEventListener("input", () => {
  blockedBox.hidden = true;
  updateCharsLeft();
  resize();
  showSuggestions();
});
input.addEventListener("focus", showSuggestions);
input.addEventListener("blur", closeSuggestions);
// Load Rampart Edge while the student reads the page, so it's ready when they ask. With Save-Data
// on, wait until they start typing.
const warm = () => void pii().then((p) => p.warmUp()).catch(() => undefined);
if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) {
  input.addEventListener("focus", warm, { once: true });
} else {
  window.addEventListener("load", warm, { once: true });
}
for (const chip of document.querySelectorAll<HTMLButtonElement>("[data-ask]")) {
  chip.addEventListener("click", () => void ask(chip.textContent ?? "", true));
}
retryButton.addEventListener("click", () => void ask(input.value));
newChatButton.addEventListener("click", () => {
  controller?.abort();
  closeSuggestions();
  turns = [];
  thread.replaceChildren();
  delete body.dataset.docked; // back at the top, where the box sits on the card
  setMode("welcome");
  blockedBox.hidden = true;
  hideError();
  input.value = "";
  resize();
  window.scrollTo({ top: 0 });
  input.focus();
});

fetch("/api/health")
  .then((r) => r.json() as Promise<{ pages?: number }>)
  .then((h) => {
    if (h.pages) $("page-count").textContent = h.pages.toLocaleString("en-US");
  })
  .catch(() => undefined);

rotateExamples();
slideshow();
dockOnScroll();
splitWords($("manifesto"));
loopMarquees();
syncSend();
