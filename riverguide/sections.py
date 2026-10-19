"""Public course-section lookup: the one kind of record that is not a web page.

Term schedules come from a protected operational export, sanitized into
data/sections.db under docs/sections-data-contract.md (carried over unchanged
from RiverGuide 1). Only Active, non-hidden rows and allowlisted fields are
stored. Results are a dated snapshot, never a live registration record.
"""
from __future__ import annotations

import os
import re
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("RIVERGUIDE_SECTIONS_DB", REPO_ROOT / "data" / "sections.db"))

_COURSE_CODE_RE = re.compile(r"^\s*([a-zA-Z]{2,4})\s*[- ]?\s*([pP]?\d{3,4}[a-zA-Z]?)\s*$")
_DELIVERY_ALIASES: dict[str, tuple[str, ...]] = {
    "online": ("ONL", "SYNC"),
    "online_async": ("ONL",),
    "onl": ("ONL",),
    "online_live": ("SYNC",),
    "sync": ("SYNC",),
    "hybrid": ("HYBR",),
    "hybr": ("HYBR",),
    "in_person": ("PERS",),
    "pers": ("PERS",),
}
_CAMPUS_ALIASES = {
    "onl": "ONL", "online": "ONL", "river_online": "ONL",
    "mas": "MAS", "massey": "MAS", "main": "MAS", "main_campus": "MAS",
    "pru": "PRU", "pruitt": "PRU", "psl": "PRU", "port_st_lucie": "PRU",
    "port_saint_lucie": "PRU", "st_lucie_west": "PRU",
    "cha": "CHA", "chastain": "CHA", "stuart": "CHA",
    "mue": "MUE", "mueller": "MUE", "vero": "MUE", "vero_beach": "MUE",
    "dhc": "DHC", "dixon": "DHC", "hendry": "DHC", "dixon_hendry": "DHC", "okeechobee": "DHC",
    "beb": "BEB", "blackburn": "BEB",
    "ich": "ICH", "indiantown": "ICH", "indiantown_high_school": "ICH",
}
# City names that cover more than one campus. Do not guess.
_CAMPUS_AMBIGUOUS = {"fort_pierce", "ft_pierce"}
_CAMPUS_NAME_HINTS = (
    ("massey", "MAS"), ("pruitt", "PRU"), ("chastain", "CHA"), ("mueller", "MUE"),
    ("blackburn", "BEB"), ("dixon_hendry", "DHC"), ("dixon", "DHC"), ("hendry", "DHC"),
    ("indiantown", "ICH"), ("river_online", "ONL"),
)
PUBLIC_VISIBILITY = {
    "included": "Only source rows marked Active and not hidden are eligible for the sanitized public snapshot.",
    "excluded": "Cancelled and source-hidden sections are excluded before this query layer and cannot be returned.",
}
SEAT_STATUS_CAVEAT = (
    "seat_status is a source-reported open/full category as of the snapshot "
    "time, not an exact seat count or a real-time guarantee. Verify availability "
    "in the River Portal before registering."
)


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _normalize_course_code(code: str) -> str:
    match = _COURSE_CODE_RE.match(code)
    if match:
        return f"{match.group(1).upper()} {match.group(2).upper()}"
    return re.sub(r"\s+", " ", code.strip().upper())


def _normalize_delivery(delivery: str) -> tuple[str, ...]:
    codes = _DELIVERY_ALIASES.get(re.sub(r"[-\s]+", "_", delivery.strip().lower()))
    if codes is None:
        raise ValueError(
            f"Unknown delivery filter {delivery!r}; use one of: "
            "online, online_async, online_live, hybrid, in_person"
        )
    return codes


def _normalize_campus(campus: str) -> str:
    key = re.sub(r"[^a-z0-9]+", "_", campus.strip().lower()).strip("_")
    if not key:
        raise ValueError("campus filter is empty")
    for candidate in (key, key.removesuffix("_campus")):
        if candidate in _CAMPUS_AMBIGUOUS:
            raise ValueError(
                f"Campus filter {campus!r} matches Massey (MAS) and Blackburn "
                "(BEB). Ask which Fort Pierce campus they mean."
            )
        if candidate in _CAMPUS_ALIASES:
            return _CAMPUS_ALIASES[candidate]
    hinted = {code for token, code in _CAMPUS_NAME_HINTS if f"_{token}_" in f"_{key}_"}
    if len(hinted) == 1:
        return hinted.pop()
    raise ValueError(
        f"Unknown campus filter {campus!r}; use Massey, Pruitt, Chastain, "
        "Mueller, Dixon Hendry, Blackburn, or River Online."
    )


def _freshness(exported_at: str | None) -> dict[str, Any]:
    max_age_hours = float(os.environ.get("IRSC_SECTIONS_MAX_AGE_HOURS", "24") or 24)
    base: dict[str, Any] = {
        "mode": "snapshot",
        "real_time": False,
        "as_of": exported_at,
        "max_age_hours": max_age_hours,
        "caveat": (
            "Course-section data is a point-in-time source export. Schedules and "
            "seat status may have changed; verify in the River Portal."
        ),
    }
    try:
        parsed = datetime.fromisoformat(str(exported_at).strip().replace("Z", "+00:00"))
    except ValueError:
        return {**base, "status": "unknown", "age_hours": None}
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    age_hours = max(0.0, (datetime.now(timezone.utc) - parsed).total_seconds() / 3600)
    return {
        **base,
        "status": "fresh" if age_hours <= max_age_hours else "stale",
        "age_hours": round(age_hours, 2),
    }


def search_sections(
    term: str,
    course_code: str | None = None,
    crn: str | None = None,
    keyword: str | None = None,
    delivery: str | None = None,
    campus: str | None = None,
    open_only: bool = False,
    limit: int | None = None,
) -> dict:
    """Search the latest sanitized public course-section snapshot for a term."""
    if not isinstance(term, str) or not term.strip():
        raise ValueError("term is required")
    requested_term = term.strip()
    normalized_term = re.sub(r"[-_\s]+", " ", requested_term.lower())
    code = _normalize_course_code(course_code) if course_code and course_code.strip() else None
    delivery_codes = _normalize_delivery(delivery) if delivery and delivery.strip() else None
    campus_code = _normalize_campus(campus) if campus and campus.strip() else None
    if limit is None:
        result_limit = 100 if code else 25
    else:
        result_limit = max(1, min(int(limit), 100))
    filters: dict[str, Any] = {
        "course_code": code,
        "crn": crn.strip() if crn and crn.strip() else None,
        "keyword": keyword.strip() if keyword and keyword.strip() else None,
        "delivery": delivery.strip() if delivery and delivery.strip() else None,
        "delivery_codes": list(delivery_codes) if delivery_codes else None,
        "campus": campus_code,
        "open_only": bool(open_only),
        "limit": result_limit,
    }

    with closing(_connect()) as conn:
        snapshot = conn.execute(
            """
            SELECT s.snapshot_id, s.public_verification_url, s.exported_at,
                   s.source_term_code, s.term_id, t.title AS term_title
            FROM course_section_snapshots s
            JOIN terms t ON t.canonical_id = s.term_id
            WHERE LOWER(CAST(s.source_term_code AS TEXT)) = ?
               OR LOWER(REPLACE(s.term_id, '-', ' ')) = ?
               OR LOWER(t.title) = ?
            ORDER BY s.exported_at DESC, s.snapshot_id DESC
            LIMIT 1
            """,
            (requested_term.lower(), normalized_term, normalized_term),
        ).fetchone()

        if snapshot is None:
            return {
                "requested_term": requested_term,
                "covered_term": None,
                "as_of": None,
                "freshness": _freshness(None),
                "coverage": {
                    "covered": False,
                    "semantics": "No successful sanitized course-section snapshot covers the requested term.",
                },
                "public_visibility": PUBLIC_VISIBILITY,
                "filters": filters,
                "source": None,
                "seat_status_caveat": SEAT_STATUS_CAVEAT,
                "message": (
                    "No course-section snapshot is available for this term. "
                    "This does not mean the course or section is never offered."
                ),
                "match_count": 0,
                "truncated": False,
                "sections": [],
            }

        clauses = ["cs.snapshot_id = ?", "cs.term_id = ?"]
        params: list[Any] = [snapshot["snapshot_id"], snapshot["term_id"]]
        if code:
            clauses.append("cs.course_code = ?")
            params.append(code)
        if filters["crn"]:
            clauses.append("cs.crn = ?")
            params.append(filters["crn"])
        if filters["keyword"]:
            fields = ("cs.course_code", "cs.course_title", "cs.long_course_title", "cs.schedule_type")
            clauses.append("(" + " OR ".join(f"LOWER(COALESCE({f}, '')) LIKE ?" for f in fields) + ")")
            params.extend([f"%{filters['keyword'].lower()}%"] * len(fields))
        if delivery_codes:
            clauses.append(f"UPPER(cs.instructional_method) IN ({', '.join('?' for _ in delivery_codes)})")
            params.extend(delivery_codes)
        if campus_code:
            clauses.append("LOWER(TRIM(cs.campus)) = ?")
            params.append(campus_code.lower())
        if open_only:
            clauses.append("cs.seat_status = 'reported_open'")
        where = " AND ".join(clauses)
        match_count = conn.execute(f"SELECT COUNT(*) FROM course_sections cs WHERE {where}", params).fetchone()[0]
        sections = [
            dict(row)
            for row in conn.execute(
                f"""
                SELECT cs.crn, cs.course_code, cs.course_section AS section,
                       COALESCE(NULLIF(cs.long_course_title, ''), NULLIF(cs.course_title, '')) AS title,
                       cs.part_of_term, cs.delivery, cs.campus,
                       cs.start_date_text, cs.end_date_text,
                       cs.meeting_schedule, cs.location_summary,
                       cs.schedule_type, cs.seat_status
                FROM course_sections cs
                WHERE {where}
                ORDER BY cs.course_code COLLATE NOCASE, cs.course_section COLLATE NOCASE, cs.crn
                LIMIT ?
                """,
                [*params, result_limit],
            )
        ]

    truncated = match_count > len(sections)
    if match_count == 0:
        message = (
            "No active, publicly visible section matches these filters in the "
            "latest covered snapshot. This does not mean the course is never "
            "offered; schedules change by term and snapshot."
        )
    elif truncated:
        message = (
            f"Showing {len(sections)} of {match_count} active, publicly visible "
            "matches in the latest covered snapshot. This is a page, not the full "
            "set. Narrow by course code or campus, or raise limit. Not a real-time "
            "registration record."
        )
    else:
        message = (
            "These are active, publicly visible matches in the latest covered "
            "snapshot, not a real-time registration record."
        )
    return {
        "title": f"{snapshot['term_title']} class listings",
        "url": snapshot["public_verification_url"],
        "requested_term": requested_term,
        "covered_term": {
            "term_id": snapshot["term_id"],
            "title": snapshot["term_title"],
            "source_term_code": snapshot["source_term_code"],
        },
        "as_of": snapshot["exported_at"],
        "freshness": _freshness(snapshot["exported_at"]),
        "coverage": {"covered": True, "semantics": "Latest successful sanitized snapshot for this term."},
        "public_visibility": PUBLIC_VISIBILITY,
        "filters": filters,
        "source": {"public_verification_url": snapshot["public_verification_url"]},
        "seat_status_caveat": SEAT_STATUS_CAVEAT,
        "message": message,
        "match_count": match_count,
        "truncated": truncated,
        "sections": sections,
    }
