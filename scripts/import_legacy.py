#!/usr/bin/env python3
"""Seed RiverGuide 2.0 from RiverGuide 1 (irsc-knowledge-base).

Copies the public scraped pages (raw/irsc, raw/catalog, raw/irsc-libguides)
into corpus/ and the sanitized course-section snapshot into data/sections.db.
Nothing from raw/internal or wiki/ is copied.

The full import seeded corpus/ once; `python -m riverguide.crawl` owns it now.
--sections-only keeps copying the section snapshot, because the protected-export
importer still lives in RiverGuide 1 (deploy/omarchy/nightly.sh runs it).

    .venv/bin/python scripts/import_legacy.py --legacy ../irsc-knowledge-base
    .venv/bin/python scripts/import_legacy.py --legacy ../irsc-knowledge-base --sections-only
"""
from __future__ import annotations

import argparse
import hashlib
import re
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from riverguide.corpus import CORPUS_DIR, Page, write_checked, write_page  # noqa: E402

PUBLIC_TREES = ("raw/irsc", "raw/catalog", "raw/irsc-libguides")
LINK_BASES = {
    "irsc": "https://irsc.edu/",
    "catalog": "https://irsc.smartcatalogiq.com/en/current/catalog/",
}
FRONTMATTER_RE = re.compile(r"\A---\n(.*?)\n---\n?", re.DOTALL)
WIKILINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]")


def wikilink_to_markdown(match: re.Match) -> str:
    target, text = match.group(1).strip(), (match.group(2) or "").strip()
    root, _, rest = target.partition("/")
    label = text or rest.rsplit("/", 1)[-1].replace("-", " ") or target
    base = LINK_BASES.get(root)
    if base is None:
        return label
    return f"[{label}]({base}{rest})"


def page_title(meta: dict, body: str) -> str:
    """'Parent > Parent > Page heading', using the page's own H1 when it has one."""
    h1 = re.search(r"^# (.+)$", body, re.MULTILINE)
    own = h1.group(1) if h1 else str(meta.get("title") or "")
    own = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", own).replace("**", "").replace("__", "").strip()
    crumbs = [str(c).strip() for c in (meta.get("breadcrumb") or [])[:-1]]
    crumbs = [c for c in crumbs if c and c != "IRSC" and not c.isdigit()]
    return " > ".join([*crumbs, own]) if own else " > ".join(crumbs)


def import_corpus(legacy: Path) -> int:
    if CORPUS_DIR.exists():
        shutil.rmtree(CORPUS_DIR)
    count = 0
    for tree in PUBLIC_TREES:
        for path in sorted((legacy / tree).rglob("*.md")):
            raw = path.read_text(encoding="utf-8")
            match = FRONTMATTER_RE.match(raw)
            if not match:
                continue
            meta = yaml.safe_load(match.group(1)) or {}
            url = meta.get("source_url")
            if not isinstance(url, str) or not url.startswith("http"):
                continue
            body = WIKILINK_RE.sub(wikilink_to_markdown, raw[match.end():]).strip()
            if not body:
                continue
            write_page(
                Page(url=url, title=page_title(meta, body), updated=str(meta.get("scraped_at") or ""), text=body)
            )
            count += 1
    return count


SECTION_TABLES = ("terms", "course_section_snapshots", "course_sections")


def content_digest(db: Path) -> str:
    """Hash of the rows, so a different SQLite version writing different bytes isn't a change."""
    digest = hashlib.sha256()
    with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as conn:
        for table in SECTION_TABLES:
            for row in sorted(repr(r) for r in conn.execute(f"SELECT * FROM {table}")):
                digest.update(row.encode())
    return digest.hexdigest()


def import_sections(legacy: Path, target: Path) -> int:
    """Rebuild the snapshot next to target; replace target only if the rows changed."""
    source = legacy / "db" / "irsc.db"
    staged = target.with_suffix(".db.new")
    staged.unlink(missing_ok=True)
    target.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(f"file:{staged}", uri=True) as conn:
        conn.execute("ATTACH DATABASE ? AS legacy", (f"file:{source}?mode=ro",))
        conn.execute("CREATE TABLE terms (canonical_id TEXT PRIMARY KEY, title TEXT NOT NULL)")
        conn.execute("INSERT INTO terms SELECT canonical_id, title FROM legacy.terms")
        for table in ("course_section_snapshots", "course_sections"):
            (schema,) = conn.execute(
                "SELECT sql FROM legacy.sqlite_master WHERE type = 'table' AND name = ?", (table,)
            ).fetchone()
            conn.execute(schema)
            conn.execute(f"INSERT INTO {table} SELECT * FROM legacy.{table}")
        indexes = conn.execute(
            "SELECT sql FROM legacy.sqlite_master WHERE type = 'index' AND sql IS NOT NULL "
            "AND tbl_name IN ('course_section_snapshots', 'course_sections')"
        ).fetchall()
        for (sql,) in indexes:
            conn.execute(sql)
        (rows,) = conn.execute("SELECT COUNT(*) FROM course_sections").fetchone()
        conn.commit()
        conn.execute("DETACH DATABASE legacy")
    with sqlite3.connect(staged) as conn:
        conn.execute("VACUUM")
    if target.exists() and content_digest(target) == content_digest(staged):
        staged.unlink()
    else:
        staged.replace(target)
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--legacy", type=Path, default=REPO_ROOT.parent / "irsc-knowledge-base")
    parser.add_argument("--sections-only", action="store_true", help="refresh data/sections.db, leave corpus/ alone")
    args = parser.parse_args()
    legacy = args.legacy.resolve()
    if args.sections_only:
        sections = import_sections(legacy, REPO_ROOT / "data" / "sections.db")
        print(f"data/sections.db: {sections} public section rows")
        return 0
    pages = import_corpus(legacy)
    # v1's nightly refresh re-checks every page and commits raw/ when anything changed.
    checked = subprocess.run(
        ["git", "-C", str(legacy), "log", "-1", "--format=%cs", "--", "raw"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    write_checked(checked)
    sections = import_sections(legacy, REPO_ROOT / "data" / "sections.db")
    print(f"corpus/: {pages} pages checked {checked}; data/sections.db: {sections} public section rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
