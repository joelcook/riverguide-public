#!/usr/bin/env bash
# Install or update RiverGuide on omarchy as a systemd user service (no sudo;
# the irsc user has lingering on, so it starts at boot like the system units).
#
#   ./deploy/omarchy/install.sh          venv, tests, .env (first run only), service, smoke test
#   ./deploy/omarchy/install.sh --cron   also schedule the nightly crawl at 04:30
#
# The server binds 127.0.0.1:8765 only. Public access goes through the existing
# Cloudflare tunnel once a hostname points at http://127.0.0.1:8765.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

[[ -d .venv ]] || python3.14 -m venv .venv
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet -r requirements-dev.txt
.venv/bin/python -W ignore -m unittest discover -s tests -t . 2>&1 | tail -3

if [[ ! -f .env ]]; then
    umask 077
    token="$(.venv/bin/python -c 'import secrets; print(secrets.token_urlsafe(32))')"
    printf 'IRSC_MCP_HOST=127.0.0.1\nIRSC_MCP_PORT=8765\nIRSC_MCP_API_KEY=%s\nIRSC_MCP_ALLOWED_HOSTS=\n' "$token" > .env
    echo "created .env with a new bearer token; read it with: grep IRSC_MCP_API_KEY $repo/.env"
fi
mkdir -p logs ~/.config/systemd/user
install -m 644 deploy/omarchy/riverguide.service ~/.config/systemd/user/riverguide.service
systemctl --user daemon-reload
systemctl --user enable --quiet riverguide.service
systemctl --user restart riverguide.service

set -a; source .env; set +a
for _ in $(seq 1 30); do
    (exec 3<>"/dev/tcp/127.0.0.1/${IRSC_MCP_PORT}") 2>/dev/null && break
    sleep 1
done
.venv/bin/python -W ignore scripts/check_server.py --endpoint "http://127.0.0.1:${IRSC_MCP_PORT}/mcp"

if [[ "${1:-}" == "--cron" ]]; then
    line="30 4 * * * /bin/bash -lc '$repo/deploy/omarchy/nightly.sh' >> $repo/logs/nightly.log 2>&1"
    { crontab -l 2>/dev/null | grep -vF "deploy/omarchy/nightly.sh" || true; echo "$line"; } | crontab -
    echo "nightly crawl scheduled: $line"
fi
