<!-- Carried over unchanged from RiverGuide 1 (irsc-knowledge-base/docs/course-sections-data-contract.md).
     In RiverGuide 2.0 the sanitized projection lives in data/sections.db (tables: terms,
     course_section_snapshots, course_sections) and is copied from v1's db/irsc.db by
     scripts/import_legacy.py. v1's XLSX importer (scripts/course_sections.py) still produces it
     until it is ported here. The runtime query is riverguide/sections.py. -->

# Course Sections Data Contract

## Purpose and Status

This contract governs the protected operational course-section export and the
sanitized public projection used by RiverGuide. On 2026-08-17 the data owner
confirmed that Banner term `202701` is Fall 2026, that Hidden means the class
is not on the public schedule, and that `ONL` is a regular online class. The
remaining items at the end are still open.

The course-section feed describes public offerings at a point in time. It is
not a student-record feed, registration system, waitlist, or real-time seat
service.

## Data Boundaries

| Zone | Contents | Runtime/public status |
|---|---|---|
| Protected source | Original operational XLSX under `raw/internal/course-sections/` | Build-time evidence only. Excluded from the container build by `.dockerignore`; never returned by MCP or wiki search. |
| Sanitized projection | `course_section_snapshots` provenance plus allowlisted `course_sections` rows in `db/irsc.db` | Read-only runtime data. Contains only rows passing the publication rule and only the fields listed below. |
| Public MCP result | `search_sections` envelope and section rows | Latest covered sanitized snapshot only; carries as-of/freshness and seat-state caveats. |

The protected source contains no student names, IDs, grades, registrations, or
other student-level records. The importer must fail closed if a future schema
introduces an unexpected column; new fields are not public until this allowlist
is deliberately reviewed.

## Publication Rule

A source row is eligible for the public projection only when both conditions
are true:

- `Section Status` is exactly `Active`.
- `Hidden Course Section` is exactly `N`.

Owner wording, 2026-08-17: Hidden means the class is **not** on the public
schedule. `N` is therefore the public-schedule value we keep. Cancelled and
hidden rows are excluded before the query layer and cannot be returned by
`search_sections`.

For each canonical term, queries use the newest successfully ingested sanitized
snapshot. Source term `202701` maps to `fall-2026` by owner confirmation.
Dates must never be used to guess the term.

## Runtime Projection Allowlist

Snapshot provenance may contain only:

- `snapshot_id`, protected `source_path`, `public_verification_url`, and
  `source_sha256`
- `exported_at`, `source_view`, and `source_schema_version`
- `classification` and `allowlist_policy`
- source/public row counts
- `source_term_code`, `term_mapping_basis`, and canonical `term_id`

Public section rows may contain only:

- identifiers: `snapshot_id`, `term_id`, `source_term_code`, `crn`,
  `course_code`, and `course_section`
- labels: `course_title`, `long_course_title`, `part_of_term`, and
  `schedule_type`
- delivery/logistics: approved `instructional_method`, normalized `delivery`,
  `campus`, `meeting_schedule`, and `location_summary`
- section dates: `start_date_text` and `end_date_text`
- availability: categorical `seat_status` only (`reported_open` or
  `reported_full`)

The public MCP response is narrower still. Its envelope is limited to
`requested_term`, `covered_term`, `as_of`, `freshness`, `coverage`,
`public_visibility`, `filters`, `source: {public_verification_url}`,
`seat_status_caveat`, `message`, `match_count`, `truncated`, and `sections`.
Each section is limited to
`crn`, `course_code`, `section`, `title`, `part_of_term`, `delivery`, `campus`,
`start_date_text`, `end_date_text`, `meeting_schedule`, `location_summary`,
`schedule_type`, and `seat_status`. Protected source paths, hashes, and snapshot
IDs stay in database provenance for audits and must not be returned through MCP.

## Explicit Exclusions

The public projection must not contain:

- the source workbook or arbitrary source columns
- hidden or cancelled section rows
- instructor names or missing-instructor flags
- exact section capacity, enrollment count, seats remaining, or over-capacity
  counts
- reserved attributes, reserved capacity, or waitlist capacity
- section fees or distance-fee internals
- special-approval, tuition-waiver, internal taxonomy, activity/audit, seat-time,
  seat-percentage, or quality-check fields
- student identifiers, enrollments, grades, schedules, holds, balances, or any
  other FERPA-protected student record

## Freshness and Seat-State Semantics

Every result must state the snapshot export time and that it is not real-time.
`seat_status` is derived from the source's reported state at export time; it is
not an exact count, a reservation-eligibility decision, or a promise that the
student can register. Students must verify current availability in The River
Portal.

A zero-result search means only that no active, publicly visible row matched the
term and filters in the latest covered snapshot. It must never be paraphrased as
"the course does not exist," "the College never offers it," or a conclusion
about another term.

## Required Validation

Before publishing a snapshot, the importer must validate at least:

- expected source headers/schema version and unique `(term, CRN)` rows
- explicit term-code mapping and parseable export timestamp
- exact publication predicates (`Active` and `N`)
- delivery mapping and allowed seat-status categories
- source/public row counts and source SHA-256 lineage
- absence of excluded columns from `course_sections`

Publishing must be atomic: a failed import leaves the previous successful
snapshot in service.

## Owner Confirmations

Confirmed 2026-08-17:

- Banner term `202701` is Fall 2026.
- Hidden means the class is not on the public schedule. RiverGuide keeps only
  `Hidden Course Section=N`.
- `ONL` is a regular online class.

Still open:

- Student-facing wording for `SYNC`, `HYBR`, and `PERS`.
- How often a fresh export will arrive, and how old the snapshot may be.
- The public page and office to use when a listing looks wrong.
