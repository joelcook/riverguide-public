// The three tools over D1. A port of riverguide/index.py and riverguide/sections.py:
// same FTS5 query, same BM25 weights, same excerpts (precomputed by riverguide/export_d1.py).

const MAX_RESULTS = 10;
const READ_CHARS = 15000;

const STOPWORDS = new Set(
  `a about an and are as at be been but by can could did do does for from
  get got had has have how i if in into is it its me my of on or our should
  so than that the their them then there these this to was we what when
  where which who why will with would you your`.split(/\s+/),
);

/** OR the query's terms together, plus adjacent pairs as phrases (see fts_query in index.py). */
export function ftsQuery(query: string): string | null {
  const tokens = (query.match(/[\p{L}\p{N}]+/gu) ?? []).map((t) => t.toLowerCase());
  let terms = tokens.filter((t) => !STOPWORDS.has(t) && t.length > 1);
  if (!terms.length) terms = tokens.filter((t) => t.length > 1);
  if (!terms.length) return null;
  const pairs = terms.slice(1).map((t, i) => `${terms[i]} ${t}`);
  return [...new Set(terms), ...new Set(pairs)].map((t) => `"${t}"`).join(" OR ");
}

/** https, no www, no fragment, no trailing slash (normalize_url in corpus.py). */
export function normalizeUrl(url: string): string | null {
  try {
    const u = new URL(url.trim());
    const host = u.host.toLowerCase().replace(/^www\./, "");
    return `https://${host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return null;
  }
}

export interface SearchResult {
  title: string;
  url: string;
  updated: string;
  section?: string;
  excerpt: string;
}

export async function checkedDate(db: D1Database): Promise<string> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'checked'").first<{ value: string }>();
  return row?.value ?? "";
}

export async function search(db: D1Database, query: string, limit = 8) {
  const match = ftsQuery(query);
  const checked = await checkedDate(db);
  if (!match) return { checked, results: [] as SearchResult[], note: NO_MATCH };
  const n = Math.max(1, Math.min(Math.trunc(Number(limit) || 8), MAX_RESULTS));
  const { results: rows } = await db
    .prepare(
      `WITH hits AS (
         SELECT rowid, page_id, bm25(chunks, 8.0, 4.0, 1.0) AS score
         FROM chunks WHERE chunks MATCH ?1 ORDER BY score LIMIT 400
       ), best AS (
         SELECT rowid, page_id, score, ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY score, rowid) AS rn FROM hits
       )
       SELECT p.title, p.url, p.updated, c.section, c.excerpt
       FROM best b JOIN chunks c ON c.rowid = b.rowid JOIN pages p ON p.id = b.page_id
       WHERE b.rn = 1 ORDER BY b.score, b.rowid LIMIT ?2`,
    )
    .bind(match, n)
    .all<{ title: string; url: string; updated: string; section: string; excerpt: string }>();
  const results: SearchResult[] = rows.map(({ section, ...r }) => (section ? { ...r, section, excerpt: r.excerpt } : r));
  if (!results.length) return { checked, results, note: NO_MATCH };
  return {
    checked,
    results,
    note:
      "Excerpts from official College pages, all re-checked against the live site on the " +
      "'checked' date. Quote dates, amounts, and contacts exactly as written.",
  };
}

const NO_MATCH = "No matching pages. Try different words, an official name, or a spelled-out acronym.";

export async function readPage(db: D1Database, url: string, start = 0) {
  const key = normalizeUrl(url);
  const page = key
    ? await db
        .prepare("SELECT id, url, title, updated, length FROM pages WHERE url_key = ?")
        .bind(key)
        .first<{ id: number; url: string; title: string; updated: string; length: number }>()
    : null;
  if (!page) return { error: "That url is not one of the College pages in the index. Use search to find official pages." };
  const { results } = await db
    .prepare("SELECT text FROM page_text WHERE page_id = ? ORDER BY seq")
    .bind(page.id)
    .all<{ text: string }>();
  const text = results.map((r) => r.text).join("");
  const from = Math.max(0, Math.trunc(Number(start) || 0));
  const end = from + READ_CHARS;
  return {
    title: page.title,
    url: page.url,
    updated: page.updated,
    text: text.slice(from, end),
    start: from,
    next_start: end < text.length ? end : null,
    length: text.length,
  };
}

export async function isIndexedUrl(db: D1Database, url: string): Promise<boolean> {
  const key = normalizeUrl(url);
  if (!key) return false;
  return (await db.prepare("SELECT 1 AS ok FROM pages WHERE url_key = ?").bind(key).first()) !== null;
}

// ---------- course sections (riverguide/sections.py) ----------

const DELIVERY_ALIASES: Record<string, string[]> = {
  online: ["ONL", "SYNC"],
  online_async: ["ONL"],
  onl: ["ONL"],
  online_live: ["SYNC"],
  sync: ["SYNC"],
  hybrid: ["HYBR"],
  hybr: ["HYBR"],
  in_person: ["PERS"],
  pers: ["PERS"],
};
const CAMPUS_ALIASES: Record<string, string> = {
  onl: "ONL", online: "ONL", river_online: "ONL",
  mas: "MAS", massey: "MAS", main: "MAS", main_campus: "MAS",
  pru: "PRU", pruitt: "PRU", psl: "PRU", port_st_lucie: "PRU", port_saint_lucie: "PRU", st_lucie_west: "PRU",
  cha: "CHA", chastain: "CHA", stuart: "CHA",
  mue: "MUE", mueller: "MUE", vero: "MUE", vero_beach: "MUE",
  dhc: "DHC", dixon: "DHC", hendry: "DHC", dixon_hendry: "DHC", okeechobee: "DHC",
  beb: "BEB", blackburn: "BEB",
  ich: "ICH", indiantown: "ICH", indiantown_high_school: "ICH",
};
const CAMPUS_AMBIGUOUS = new Set(["fort_pierce", "ft_pierce"]);
const CAMPUS_NAME_HINTS: [string, string][] = [
  ["massey", "MAS"], ["pruitt", "PRU"], ["chastain", "CHA"], ["mueller", "MUE"], ["blackburn", "BEB"],
  ["dixon_hendry", "DHC"], ["dixon", "DHC"], ["hendry", "DHC"], ["indiantown", "ICH"], ["river_online", "ONL"],
];
const PUBLIC_VISIBILITY = {
  included: "Only source rows marked Active and not hidden are eligible for the sanitized public snapshot.",
  excluded: "Cancelled and source-hidden sections are excluded before this query layer and cannot be returned.",
};
const SEAT_STATUS_CAVEAT =
  "seat_status is a source-reported open/full category as of the snapshot time, not an exact seat count or a " +
  "real-time guarantee. Verify availability in the River Portal before registering.";

export class FilterError extends Error {}

function normalizeCourseCode(code: string): string {
  const m = code.match(/^\s*([a-zA-Z]{2,4})\s*[- ]?\s*([pP]?\d{3,4}[a-zA-Z]?)\s*$/);
  return m ? `${m[1].toUpperCase()} ${m[2].toUpperCase()}` : code.trim().toUpperCase().replace(/\s+/g, " ");
}

function normalizeDelivery(delivery: string): string[] {
  const codes = DELIVERY_ALIASES[delivery.trim().toLowerCase().replace(/[-\s]+/g, "_")];
  if (!codes) {
    throw new FilterError(
      `Unknown delivery filter '${delivery}'; use one of: online, online_async, online_live, hybrid, in_person`,
    );
  }
  return codes;
}

function normalizeCampus(campus: string): string {
  const key = campus.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!key) throw new FilterError("campus filter is empty");
  for (const candidate of [key, key.replace(/_campus$/, "")]) {
    if (CAMPUS_AMBIGUOUS.has(candidate)) {
      throw new FilterError(
        `Campus filter '${campus}' matches Massey (MAS) and Blackburn (BEB). Ask which Fort Pierce campus they mean.`,
      );
    }
    if (candidate in CAMPUS_ALIASES) return CAMPUS_ALIASES[candidate];
  }
  const hinted = new Set(CAMPUS_NAME_HINTS.filter(([token]) => `_${key}_`.includes(`_${token}_`)).map(([, c]) => c));
  if (hinted.size === 1) return [...hinted][0];
  throw new FilterError(
    `Unknown campus filter '${campus}'; use Massey, Pruitt, Chastain, Mueller, Dixon Hendry, Blackburn, or River Online.`,
  );
}

function freshness(exportedAt: string | null, maxAgeHours: number) {
  const base = {
    mode: "snapshot",
    real_time: false,
    as_of: exportedAt,
    max_age_hours: maxAgeHours,
    caveat:
      "Course-section data is a point-in-time source export. Schedules and seat status may have changed; verify in the River Portal.",
  };
  const parsed = exportedAt ? Date.parse(exportedAt) : NaN;
  if (Number.isNaN(parsed)) return { ...base, status: "unknown", age_hours: null };
  const ageHours = Math.max(0, (Date.now() - parsed) / 3_600_000);
  return { ...base, status: ageHours <= maxAgeHours ? "fresh" : "stale", age_hours: Math.round(ageHours * 100) / 100 };
}

export interface SectionFilters {
  term: string;
  course_code?: string | null;
  crn?: string | null;
  keyword?: string | null;
  delivery?: string | null;
  campus?: string | null;
  open_only?: boolean;
  limit?: number | null;
}

export async function searchSections(db: D1Database, f: SectionFilters, maxAgeHours = 24) {
  if (!f.term?.trim()) throw new FilterError("term is required");
  const requestedTerm = f.term.trim();
  const normalizedTerm = requestedTerm.toLowerCase().replace(/[-_\s]+/g, " ");
  const code = f.course_code?.trim() ? normalizeCourseCode(f.course_code) : null;
  const deliveryCodes = f.delivery?.trim() ? normalizeDelivery(f.delivery) : null;
  const campusCode = f.campus?.trim() ? normalizeCampus(f.campus) : null;
  const limit = f.limit == null ? (code ? 100 : 25) : Math.max(1, Math.min(Math.trunc(f.limit), 100));
  const filters = {
    course_code: code,
    crn: f.crn?.trim() || null,
    keyword: f.keyword?.trim() || null,
    delivery: f.delivery?.trim() || null,
    delivery_codes: deliveryCodes,
    campus: campusCode,
    open_only: Boolean(f.open_only),
    limit,
  };

  const snapshot = await db
    .prepare(
      `SELECT s.snapshot_id, s.public_verification_url, s.exported_at, s.source_term_code, s.term_id, t.title AS term_title
       FROM course_section_snapshots s JOIN terms t ON t.canonical_id = s.term_id
       WHERE LOWER(CAST(s.source_term_code AS TEXT)) = ?1 OR LOWER(REPLACE(s.term_id, '-', ' ')) = ?2 OR LOWER(t.title) = ?2
       ORDER BY s.exported_at DESC, s.snapshot_id DESC LIMIT 1`,
    )
    .bind(requestedTerm.toLowerCase(), normalizedTerm)
    .first<{
      snapshot_id: string;
      public_verification_url: string;
      exported_at: string;
      source_term_code: string;
      term_id: string;
      term_title: string;
    }>();

  if (!snapshot) {
    return {
      requested_term: requestedTerm,
      covered_term: null,
      as_of: null,
      freshness: freshness(null, maxAgeHours),
      coverage: { covered: false, semantics: "No successful sanitized course-section snapshot covers the requested term." },
      public_visibility: PUBLIC_VISIBILITY,
      filters,
      source: null,
      seat_status_caveat: SEAT_STATUS_CAVEAT,
      message: "No course-section snapshot is available for this term. This does not mean the course or section is never offered.",
      match_count: 0,
      truncated: false,
      sections: [],
    };
  }

  const clauses = ["cs.snapshot_id = ?", "cs.term_id = ?"];
  const params: unknown[] = [snapshot.snapshot_id, snapshot.term_id];
  if (code) {
    clauses.push("cs.course_code = ?");
    params.push(code);
  }
  if (filters.crn) {
    clauses.push("cs.crn = ?");
    params.push(filters.crn);
  }
  if (filters.keyword) {
    const fields = ["cs.course_code", "cs.course_title", "cs.long_course_title", "cs.schedule_type"];
    clauses.push("(" + fields.map((x) => `LOWER(COALESCE(${x}, '')) LIKE ?`).join(" OR ") + ")");
    params.push(...fields.map(() => `%${filters.keyword!.toLowerCase()}%`));
  }
  if (deliveryCodes) {
    clauses.push(`UPPER(cs.instructional_method) IN (${deliveryCodes.map(() => "?").join(", ")})`);
    params.push(...deliveryCodes);
  }
  if (campusCode) {
    clauses.push("LOWER(TRIM(cs.campus)) = ?");
    params.push(campusCode.toLowerCase());
  }
  if (filters.open_only) clauses.push("cs.seat_status = 'reported_open'");
  const where = clauses.join(" AND ");

  const count = await db
    .prepare(`SELECT COUNT(*) AS n FROM course_sections cs WHERE ${where}`)
    .bind(...params)
    .first<{ n: number }>();
  const matchCount = count?.n ?? 0;
  const { results: sections } = await db
    .prepare(
      `SELECT cs.crn, cs.course_code, cs.course_section AS section,
              COALESCE(NULLIF(cs.long_course_title, ''), NULLIF(cs.course_title, '')) AS title,
              cs.part_of_term, cs.delivery, cs.campus, cs.start_date_text, cs.end_date_text,
              cs.meeting_schedule, cs.location_summary, cs.schedule_type, cs.seat_status
       FROM course_sections cs WHERE ${where}
       ORDER BY cs.course_code COLLATE NOCASE, cs.course_section COLLATE NOCASE, cs.crn LIMIT ?`,
    )
    .bind(...params, limit)
    .all();

  const truncated = matchCount > sections.length;
  const message =
    matchCount === 0
      ? "No active, publicly visible section matches these filters in the latest covered snapshot. This does not mean " +
        "the course is never offered; schedules change by term and snapshot."
      : truncated
        ? `Showing ${sections.length} of ${matchCount} active, publicly visible matches in the latest covered snapshot. ` +
          "This is a page, not the full set. Narrow by course code or campus, or raise limit. Not a real-time registration record."
        : "These are active, publicly visible matches in the latest covered snapshot, not a real-time registration record.";
  return {
    title: `${snapshot.term_title} class listings`,
    url: snapshot.public_verification_url,
    requested_term: requestedTerm,
    covered_term: { term_id: snapshot.term_id, title: snapshot.term_title, source_term_code: snapshot.source_term_code },
    as_of: snapshot.exported_at,
    freshness: freshness(snapshot.exported_at, maxAgeHours),
    coverage: { covered: true, semantics: "Latest successful sanitized snapshot for this term." },
    public_visibility: PUBLIC_VISIBILITY,
    filters,
    source: { public_verification_url: snapshot.public_verification_url },
    seat_status_caveat: SEAT_STATUS_CAVEAT,
    message,
    match_count: matchCount,
    truncated,
    sections,
  };
}
