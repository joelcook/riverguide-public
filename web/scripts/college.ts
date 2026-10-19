// What the page takes from the College's own pages (corpus/) at build time:
//   collegeContacts()   the public phone numbers and street addresses on them, so Rampart Edge lets a
//                       student mention the College's own ("I called 772-462-4772…")
//   collegeQuestions()  the typeahead's dictionary (app/typeahead.ts): the page's own questions
//                       (app/examples.ts and the starters), the College's FAQ questions, and three
//                       questions about every catalog course
import { Glob } from "bun";
import type { Allowlist } from "@nationaldesignstudio/rampart-edge";
import { EXAMPLES, QUESTIONS } from "../app/examples";
import type { Entry } from "../app/typeahead";

const CORPUS = `${import.meta.dir}/../../corpus/`;
const INDEX_HTML = `${import.meta.dir}/../app/index.html`;

interface Page {
  url: string;
  body: string;
}

let corpus: Promise<Page[]> | null = null;
function pages(): Promise<Page[]> {
  corpus ??= (async () => {
    const out: Page[] = [];
    for await (const path of new Glob("**/*.md").scan(CORPUS)) {
      const text = await Bun.file(CORPUS + path).text();
      const url = /^url: (\S+)$/m.exec(text)?.[1];
      const end = text.indexOf("\n---", 3);
      if (url && end > 0) out.push({ url, body: text.slice(end + 4) });
    }
    return out.sort((a, b) => (a.url < b.url ? -1 : 1));
  })();
  return corpus;
}

// ---------- contacts ----------

const PHONE = /(?<![\d-])(?:\+?1[ .-]?)?\(?([2-9]\d{2})\)?[ .-]?([2-9]\d{2})[ .-](\d{4})(?![\d-])/g;
// A complete address: number and street on one line, then city, state, and ZIP (often on the next).
const ADDRESS = new RegExp(
  String.raw`\b(\d{2,6}) ((?:[NSEW]\.?(?:[NSEW]\.?)? )?(?:[A-Z0-9][\w'’.-]* ){0,4}?` +
    String.raw`(?:Avenue|Ave|Street|St|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Highway|Hwy|Parkway|Pkwy|Court|Ct|Place|Pl|Trail|Circle|Terrace|Loop)\.?` +
    String.raw`(?: [NSEW]{1,2}\b\.?)?)[,\s]+([A-Z][A-Za-z.]+(?: [A-Z][A-Za-z.]+){0,3}),? (FL|Florida),? (\d{5})\b`,
  "g",
);

/** The public phone numbers and street addresses on the College's pages, as a Rampart Edge allowlist. */
export async function collegeContacts(): Promise<Required<Pick<Allowlist, "phones" | "addresses">>> {
  const phones = new Set<string>();
  const addresses = new Set<string>();
  for (const { body } of await pages()) {
    for (const [, area, exchange, line] of body.matchAll(PHONE)) phones.add(`${area}-${exchange}-${line}`);
    for (const [, number, street, city, , zip] of body.matchAll(ADDRESS)) {
      // Rampart Edge reads "N.W." as two words and "NW" as one, and "FL" and "Florida" as different
      // words, so list each spelling.
      const plain = street.replace(/\b([NSEW])\.([NSEW])\./g, "$1$2").replace(/\.$/, "");
      for (const s of new Set([plain, street.replace(/\.$/, "")])) {
        for (const state of ["FL", "Florida"]) addresses.add(`${number} ${s}, ${city}, ${state} ${zip}`);
      }
    }
  }
  return { phones: [...phones].sort(), addresses: [...addresses].sort() };
}

// ---------- questions ----------

const WORDS = /[a-z0-9]+(?:['’-][a-z0-9]+)*/gi;
const FAQ = /^\s*(?:\*\*)?(?:\d+\.\s*)?((?:How|What|When|Where|Who|Why|Which|Can|Do|Does|Is|Are|Will|Should|Am|If)\b[^?\n]{8,110}\?)(?:\*\*)?\s*$/gm;
// Questions that only make sense on their own page ("Is the program accredited?").
const VAGUE = /\b(?:the|this) (?:program|course|class|test|exam|account|funding)\b|^(?:How do I apply|What Happens Next|Who is Eligible|Where do I report|Who should request information)\?$/i;
// "# ENC 1101 English Composition I" on the catalog's course pages.
const COURSE = /^# ([A-Z]{3} \d{4}[A-Z]?) (.+)$/m;
// Most students take 1000-level courses, then 2000-level, then developmental (0xxx), then the
// bachelor's 3000- and 4000-level ones.
const LEVELS: Record<string, number> = { "1": 1, "2": 0.9, "0": 0.8, "3": 0.7, "4": 0.6 };

function wordCount(text: string): number {
  return text.match(WORDS)?.length ?? 0;
}

/** A question with a slot: the words a student must type into before it's offered. */
function template(before: string, slot: string, after: string, prior: number): Entry {
  const start = wordCount(before);
  return { text: before + slot + after, prior, slot: [start, start + wordCount(slot)] };
}

/**
 * The typeahead's dictionary. With no record of what students ask (RiverGuide keeps none), the order
 * comes from the page and the College's pages: the page's own questions first, then FAQ questions,
 * those on general pages (irsc.edu/faq/) before those deep in one program's, then courses by level.
 */
export async function collegeQuestions(): Promise<Entry[]> {
  const all = await pages();
  const entries: Entry[] = [];
  const seen = new Set<string>();
  const add = (entry: Entry) => {
    const key = entry.text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(entry);
  };
  const chips = [...(await Bun.file(INDEX_HTML).text()).matchAll(/data-ask[^>]*>([^<]+)</g)].map((m) => m[1].trim());
  for (const text of [...chips, ...EXAMPLES, ...QUESTIONS]) add({ text, prior: 1 });
  for (const { url, body } of all) {
    const depth = new URL(url).pathname.split("/").filter(Boolean).length;
    for (const [, question] of body.matchAll(FAQ)) {
      const text = question.replace(/\s+/g, " ").trim();
      if (wordCount(text) >= 4 && !VAGUE.test(text)) add({ text, prior: 0.2 + 0.2 / Math.max(1, depth) });
    }
  }
  for (const { body } of all) {
    const course = COURSE.exec(body);
    if (!course) continue;
    const slot = `${course[1]} (${course[2].trim()})`;
    const prior = 0.1 * (LEVELS[course[1][4]] ?? 0.5) - Number(course[1].slice(4, 8)) / 1e7;
    add(template("How many credits is ", slot, "?", prior));
    add(template("What are the prerequisites for ", slot, "?", prior));
    add(template("Is ", slot, " offered online?", prior));
  }
  return entries;
}
