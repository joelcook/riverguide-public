// Rampart Edge (National Design Studio, CC0) in the browser, used the way America.gov uses
// Rampart: a message with personal information is blocked and highlighted, not silently
// rewritten. Validators (SSNs, cards, phones, emails…) and a 1.45 MB model check each question in
// a worker; either one saying BLOCK blocks it, and the same model call marks the spans, so the
// student can see what to remove. The College's own phone numbers and street addresses, taken from
// its pages at build time (scripts/college.ts), may pass.

import {
  createValidatorGate,
  createWorkerGate,
  type Allowlist,
  type Gate,
  type GateDecision,
  type RedactedSpanType,
  type WorkerGate,
} from "@nationaldesignstudio/rampart-edge";

const MODEL_WAIT_MS = 20_000;

let gate: Promise<WorkerGate> | null = null;
let validatorsOnly: Gate | null = null;
let contacts: Promise<Allowlist | undefined> | null = null;

/** The College's phone numbers and addresses. Without them the gate still works, blocking those too. */
function collegeContacts(): Promise<Allowlist | undefined> {
  contacts ??= fetch("/college-contacts.json")
    .then((response) => (response.ok ? (response.json() as Promise<Allowlist>) : undefined))
    .catch(() => undefined);
  return contacts;
}

/** Start loading the model: about 3 MB on a first visit (model, vocabulary, and runtime), then cached by the browser. */
export function warmUp(): Promise<WorkerGate> {
  if (!gate) {
    const worker = new Worker("/pii-worker.js", { type: "module" });
    gate = new Promise((resolve, reject) => {
      // createWorkerGate waits for the worker to report; one that can't start never does.
      worker.addEventListener("error", () => reject(new Error("the worker didn't start")), { once: true });
      collegeContacts()
        .then((allowlist) => createWorkerGate(worker, { modelBaseUrl: "/models/rampart-edge/", allowlist }))
        .then(resolve, reject);
    });
    gate.catch(() => worker.terminate());
  }
  return gate;
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}

/** A stretch of the question to highlight. Validator hits the model's spans don't cover have no type. */
export interface Highlight {
  start: number;
  end: number;
  type?: RedactedSpanType;
}

export interface PiiCheck {
  blocked: boolean;
  spans: Highlight[];
  /** What to tell the student when the question is blocked. */
  reason: string;
  /** False when the model could not load: only structured PII (SSNs, cards, emails…) was checked. */
  model: boolean;
}

export async function findPii(text: string): Promise<PiiCheck> {
  try {
    return toCheck(await within(warmUp().then((g) => g.check(text)), MODEL_WAIT_MS));
  } catch (error) {
    // Fall back to the validators (SSNs, cards, emails, phones…) rather than blocking the student
    // entirely; the page tells them names can't be caught (see main.ts).
    console.warn("[riverguide] Rampart Edge's model is unavailable:", error);
    validatorsOnly ??= createValidatorGate(undefined, await collegeContacts());
    return toCheck(await validatorsOnly.check(text));
  }
}

/** The gate's verdict, with every span to highlight when it blocks, in order. */
export function toCheck(decision: GateDecision): PiiCheck {
  const model = decision.model !== null;
  if (decision.verdict === "ALLOW") return { blocked: false, spans: [], reason: "", model };
  const spans: Highlight[] = (decision.spans ?? []).map(({ start, end, type }) => ({ start, end, type }));
  for (const { start, end } of decision.validators.hard) {
    if (!spans.some((s) => s.start < end && start < s.end)) spans.push({ start, end });
  }
  spans.sort((a, b) => a.start - b.start);
  return { blocked: true, spans, reason: describe(spans), model };
}

const NAMES: Partial<Record<RedactedSpanType, string>> = {
  NAME: "a name",
  ADDRESS: "a street address",
  EMAIL: "an email address",
  PHONE: "a phone number",
  GOV_ID: "an ID number",
  OTHER_ID: "an ID number",
  FINANCIAL: "a card or bank account number",
  DOB_KEYED: "a date of birth",
  URL_HANDLE: "a personal profile link",
};

function describe(spans: Highlight[]): string {
  const kinds = [...new Set(spans.map((s) => (s.type && NAMES[s.type]) || "personal information"))];
  const list = kinds.length > 1 ? `${kinds.slice(0, -1).join(", ")} and ${kinds.at(-1)}` : (kinds[0] ?? "personal information");
  const address = spans.some((s) => s.type === "ADDRESS");
  return `Your message looks like it includes ${list}. Remove it and try again.${
    address ? " Use your city or ZIP code instead of a street address." : ""
  }`;
}
