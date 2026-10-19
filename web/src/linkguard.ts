// Streaming link guard: the student never sees a link the model made up.
//
// Text streams through untouched except where a link might be forming: a markdown
// link "[label](url)" or a bare "http(s)://..." URL. Those spans are held until
// complete, then emitted as-is when the URL is allowed, or reduced to their label
// (markdown) or dropped (bare URL) when it is not.

const BARE_URL = /^https?:\/\/[^\s<>()\[\]"'`]+/;
const URL_PREFIXES = ["https://", "http://"];

export type UrlCheck = (url: string) => Promise<boolean>;

export class LinkGuard {
  private pending = "";
  removed = 0;
  readonly linked: string[] = [];

  constructor(private readonly allowed: UrlCheck) {}

  /** Feed a delta; returns the text that is safe to emit now. */
  async push(delta: string): Promise<string> {
    this.pending += delta;
    return this.drain(false);
  }

  /** End of text: resolve whatever is held. */
  async flush(): Promise<string> {
    return this.drain(true);
  }

  private async drain(final: boolean): Promise<string> {
    let out = "";
    while (this.pending) {
      const next = this.nextCandidate();
      if (next < 0) {
        // Hold back a tail that could be the start of "http(s)://".
        const keep = final ? 0 : prefixTail(this.pending);
        out += this.pending.slice(0, this.pending.length - keep);
        this.pending = this.pending.slice(this.pending.length - keep);
        break;
      }
      out += this.pending.slice(0, next);
      this.pending = this.pending.slice(next);

      if (this.pending.startsWith("[")) {
        const link = parseLink(this.pending);
        if (link.kind === "link") {
          out += (await this.check(link.url)) ? this.pending.slice(0, link.length) : link.label;
          this.pending = this.pending.slice(link.length);
          continue;
        }
        if (link.kind === "partial" && !final) break; // wait for more text
        if (link.kind === "partial" && link.inDestination) {
          out += link.label; // an unfinished link at the end: keep the words, drop the url
          this.pending = "";
          this.removed++;
          break;
        }
        out += "["; // not a link, e.g. "[Your name]"
        this.pending = this.pending.slice(1);
        continue;
      }

      const m = this.pending.match(BARE_URL);
      if (m) {
        if (!final && m[0].length === this.pending.length) break; // URL still streaming
        const url = m[0].replace(/[.,;:!?]+$/, "");
        out += (await this.check(url)) ? url : "";
        this.pending = this.pending.slice(url.length);
        continue;
      }
      if (!final && URL_PREFIXES.includes(this.pending)) break; // "https://" and nothing yet
      out += this.pending[0]; // a bare "https://" followed by a space: just text
      this.pending = this.pending.slice(1);
    }
    return out;
  }

  private nextCandidate(): number {
    const positions = [this.pending.indexOf("["), ...URL_PREFIXES.map((p) => this.pending.indexOf(p))].filter((i) => i >= 0);
    return positions.length ? Math.min(...positions) : -1;
  }

  private async check(url: string): Promise<boolean> {
    const ok = /^(https?:|mailto:|tel:)/i.test(url) && (await this.allowed(url));
    if (ok) this.linked.push(url);
    else this.removed++;
    return ok;
  }
}

type Parsed =
  | { kind: "link"; length: number; label: string; url: string }
  | { kind: "partial"; label: string; inDestination: boolean }
  | { kind: "none" };

/** Parse "[label](destination "title")" at the start of text, allowing balanced parentheses in the destination. */
export function parseLink(text: string): Parsed {
  const close = text.indexOf("]");
  const newline = text.indexOf("\n");
  if (close < 0) {
    return newline < 0 && text.length <= 301 ? { kind: "partial", label: text.slice(1), inDestination: false } : { kind: "none" };
  }
  if ((newline >= 0 && newline < close) || close > 301) return { kind: "none" };
  const label = text.slice(1, close);
  if (close + 1 === text.length) return { kind: "partial", label, inDestination: false };
  if (text[close + 1] !== "(") return { kind: "none" };
  let depth = 0;
  for (let i = close + 1; i < text.length && i - close <= 2000; i++) {
    const c = text[i];
    if (c === "\n") return { kind: "none" };
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) {
      const destination = text.slice(close + 2, i).trim().split(/\s+/)[0] ?? "";
      return { kind: "link", length: i + 1, label, url: destination.replace(/^<|>$/g, "") };
    }
  }
  return text.length - close > 2000 ? { kind: "none" } : { kind: "partial", label, inDestination: true };
}

function prefixTail(text: string): number {
  for (let n = Math.min(8, text.length); n > 0; n--) {
    const tail = text.slice(-n);
    if (URL_PREFIXES.some((p) => p.startsWith(tail))) return n;
  }
  return 0;
}

/** Links and addresses that appear in tool output: the turn's evidence. */
export function evidenceLinks(text: string): string[] {
  return text.match(/(https?:\/\/|mailto:|tel:)[^\s<>()\[\]"'`\\]+/g) ?? [];
}
