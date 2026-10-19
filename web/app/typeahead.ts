// The typeahead: as a student types, up to three questions from a dictionary built from the
// College's own pages (scripts/college.ts). It runs entirely in the browser, the way America.gov's
// does: the dictionary loads on the first keystroke, and nothing typed leaves the page until the
// student asks.
//
// Matching is word by word. Each finished word must be the question's word at that place, or within
// one typo (three to six letters) or two (seven or more); the word being typed must start one. A
// question matches from its start or, once three letters are typed, from any word. Fewest typos win,
// then matches from the start, then the likeliest question (its prior), the shortest, and A to Z,
// preferring three different next words.

export interface Entry {
  text: string;
  /** How likely a student is to want this question; only the order matters. */
  prior: number;
  /** Words [start, end) the typing must reach before the question is offered (a course's code and title). */
  slot?: [number, number];
}

export interface Suggestion {
  text: string;
  /** The part of `text` the student has typed. */
  typed: [number, number];
}

interface Word {
  word: string;
  start: number;
  end: number;
}

interface Match {
  text: string;
  score: number;
  typos: number;
  at: number;
  /** The question's next word after what was typed, to keep the three suggestions different. */
  key: string;
  typed: [number, number];
}

const WORD = /[a-z0-9]+(?:['’-][a-z0-9]+)*/gi;
const LIMIT = 3;

function words(text: string): Word[] {
  return [...text.matchAll(WORD)].map((m) => ({ word: m[0].toLowerCase().replace(/['’]/g, ""), start: m.index, end: m.index + m[0].length }));
}

/** Typos allowed in a word of this length. */
function budget(length: number): number {
  return length >= 7 ? 2 : length >= 3 ? 1 : 0;
}

/** Edits from a to b, a swap of neighbors counting as one; with `prefix`, to the closest start of b. */
function distance(a: string, b: string, prefix: boolean): number {
  let before: number[] = [];
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) next[j] = Math.min(next[j], before[j - 2] + 1);
    }
    before = row;
    row = next;
  }
  return prefix ? Math.min(...row) : row[b.length];
}

/** Typos between a typed word and a dictionary word, or undefined when they're too far apart. */
function typos(typed: string, word: string, partial: boolean, fuzzy: boolean): number | undefined {
  if (partial ? word.startsWith(typed) : word === typed) return 0;
  const allowed = fuzzy ? budget(typed.length) : 0;
  if (allowed === 0) return undefined;
  // A word still being typed is compared with the starts of words once it's five letters long;
  // before that, only with whole words ("dont" shouldn't become "cont…" or "dent…").
  const prefix = partial && typed.length >= 5;
  if (prefix ? word.length < typed.length - allowed : Math.abs(word.length - typed.length) > allowed) return undefined;
  const d = distance(typed, word, prefix);
  return d <= allowed ? d : undefined;
}

export function createTypeahead(entries: Entry[]): (text: string) => Suggestion[] {
  const questions = entries.map((entry) => ({ ...entry, words: words(entry.text) }));
  const vocabulary = [...new Set(questions.flatMap((q) => q.words.map((w) => w.word)))];
  const longest = Math.max(0, ...questions.map((q) => q.words.length));
  // The dictionary words each typed word could be, with their typos. A finished word stays the same
  // while the next one is typed, so its list is kept.
  const lists = new Map<string, Map<string, number>>();
  function candidates(typed: string, partial: boolean, fuzzy: boolean): Map<string, number> {
    const key = `${+partial}${+fuzzy}${typed}`;
    let found = lists.get(key);
    if (!found) {
      found = new Map();
      for (const word of vocabulary) {
        const t = typos(typed, word, partial, fuzzy);
        if (t !== undefined) found.set(word, t);
      }
      if (lists.size > 500) lists.clear();
      lists.set(key, found);
    }
    return found;
  }

  /** `typed` holds each typed word's candidates; `partial` is the length of the word being typed (0 if none). */
  function matchAt(q: (typeof questions)[number], typed: Map<string, number>[], partial: number, at: number): Match | undefined {
    const n = typed.length;
    if (q.words.length < at + n) return undefined;
    let total = 0;
    for (let i = 0; i < n; i++) {
      const t = typed[i].get(q.words[at + i].word);
      if (t === undefined) return undefined;
      total += t;
    }
    if (q.slot && !(q.slot[0] < at + n && at < q.slot[1])) return undefined;
    const last = q.words[at + n - 1];
    const start = q.words[at].start;
    // The typed part ends inside the word being typed, unless it was matched with a typo.
    const end = partial && typed[n - 1].get(last.word) === 0 ? last.start + Math.min(last.end - last.start, partial) : last.end;
    if (!/[a-z0-9]/i.test(q.text.slice(0, start) + q.text.slice(end))) return undefined; // adds nothing
    const key = q.words[at + (partial ? n - 1 : n)]?.word ?? "";
    return { text: q.text, score: q.prior * 0.5 ** total, typos: total, at, key, typed: [start, end] };
  }

  return function suggest(text: string): Suggestion[] {
    if (/\?\s*$/.test(text)) return []; // a finished question
    const done = words(text).map((w) => w.word);
    const partial = /[a-z0-9'’-]$/i.test(text) ? (done.pop() ?? "") : "";
    const n = done.length + (partial ? 1 : 0);
    if (n === 0 || n > longest || /\d{5,}/.test(partial)) return []; // never complete a long number
    const anywhere = (done.join("") + partial).length >= 3;
    const find = (fuzzy: boolean) => {
      const typed = done.map((w) => candidates(w, false, fuzzy));
      if (partial) typed.push(candidates(partial, true, fuzzy));
      const found: Match[] = [];
      if (typed.some((c) => c.size === 0)) return found;
      for (const q of questions) {
        let m = matchAt(q, typed, partial.length, 0);
        for (let at = 1; !m && anywhere && at + n <= q.words.length; at++) m = matchAt(q, typed, partial.length, at);
        if (m) found.push(m);
      }
      return found;
    };
    // Typos are forgiven only when nothing matches without one.
    let matches = find(false);
    if (!matches.length) matches = find(true);
    const fewest = Math.min(...matches.map((m) => m.typos));
    let best = matches.filter((m) => m.typos === fewest);
    if (best.some((m) => m.at === 0)) best = best.filter((m) => m.at === 0);
    best.sort((a, b) => b.score - a.score || a.text.length - b.text.length || (a.text < b.text ? -1 : 1));
    const chosen = new Set<Match>();
    const keys = new Set<string>();
    for (const distinct of [true, false]) {
      for (const m of best) {
        if (chosen.size >= LIMIT) break;
        if (chosen.has(m) || (distinct && keys.has(m.key))) continue;
        keys.add(m.key);
        chosen.add(m);
      }
    }
    return best.filter((m) => chosen.has(m)).map(({ text, typed }) => ({ text, typed }));
  };
}
