#!/usr/bin/env bash
# Nightly refresh on omarchy: crawl the College's pages, refresh the public
# course-section snapshot from RiverGuide 1, test, push corpus changes, load the
# corpus into Cloudflare D1 for the 2.0 Worker (when RIVERGUIDE_D1_SYNC=1 in .env),
# and restart the MCP server. Fails closed: nothing is committed or loaded unless
# the crawl and the tests pass.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
legacy="${RIVERGUIDE_LEGACY_REPO:-$HOME/Projects/irsc-knowledge-base}"
cd "$repo"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
exec 9>"$repo/logs/nightly.lock"
flock -n 9 || { echo "$(date -Is) another run holds the lock"; exit 0; }

echo "$(date -Is) start"
# Check commit identity before spending an hour crawling (set it once with git config, like v1's checkout).
git config user.email >/dev/null || { echo "$(date -Is) no git user.email in $repo; set one with git config"; exit 1; }
git pull --ff-only --quiet
.venv/bin/pip install --quiet -r requirements-dev.txt
.venv/bin/python -m riverguide.crawl
# The protected-export importer still lives in RiverGuide 1; copy its sanitized snapshot.
if [[ -f "$legacy/db/irsc.db" ]]; then
    .venv/bin/python scripts/import_legacy.py --legacy "$legacy" --sections-only
fi
.venv/bin/python -W ignore -m unittest discover -s tests -t . 2>&1 | tail -1

git add corpus data/sections.db
if ! git diff --cached --quiet; then
    git commit --quiet -m "crawl: corpus $(cat corpus/CHECKED)"
    # Code may have been pushed while we crawled; corpus/ has one writer, so this rebases cleanly.
    git pull --rebase --quiet || { git rebase --abort; echo "$(date -Is) rebase failed; corpus commit kept locally"; exit 1; }
    git push --quiet
fi
# RiverGuide 2.0: the Worker searches D1, so load the export (staged tables, then swapped in).
# The switch and the Cloudflare credentials live outside the repo, in
# ~/.config/riverguide/cloudflare.env: RIVERGUIDE_D1_SYNC=1, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID.
cf_env="$HOME/.config/riverguide/cloudflare.env"
if [[ -f "$cf_env" ]]; then set -a; source "$cf_env"; set +a; fi
if [[ "${RIVERGUIDE_D1_SYNC:-}" == "1" ]]; then
    mkdir -p web/.build && .venv/bin/python -m riverguide.export_d1 > web/.build/d1.sql
    (cd web && mise exec -- bun install --frozen-lockfile --silent && mise exec -- bunx wrangler d1 execute riverguide --remote --yes --file .build/d1.sql > /dev/null)
    echo "$(date -Is) d1: loaded corpus $(cat corpus/CHECKED)"
fi
systemctl --user restart riverguide.service
echo "$(date -Is) done: checked $(cat corpus/CHECKED)"
