#!/usr/bin/env bash
# WSL/Linux launcher for the read-only catalog health check, invoked by the
# yugcontract-health.service systemd unit.
#
# systemd runs units WITHOUT an interactive shell, so the nvm-installed
# node is invisible to `/usr/bin/env node` (status=127). This launcher
# reuses the exact Node-resolution mechanism that already works for the
# sync launcher (scripts/wsl/yugcontract-sync.sh): plain PATH first, then
# the nvm versions glob. No second Node is installed, nothing is hardcoded
# to a specific nvm path.
#
# Exit codes:
#   0/1/2  health-check classification (PASS/WARN/FAIL) — propagated as-is
#   3      node not found (distinguishable from health FAIL=2)
#   4      health-check script missing
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || { echo "[yugcontract-health] cannot cd into $ROOT"; exit 4; }

# --- node resolution (same as yugcontract-sync.sh; systemd has no nvm PATH) --
if ! command -v node >/dev/null 2>&1; then
    for d in "$HOME"/.nvm/versions/node/v*; do
        if [ -x "$d/bin/node" ]; then
            export PATH="$d/bin:$PATH"
            break
        fi
    done
fi
if ! command -v node >/dev/null 2>&1; then
    echo "[yugcontract-health] FAILED: node not found (install Node 24 LTS or nvm default)"
    exit 3
fi

# --- the health-check script itself is strictly READ-ONLY --------------------
[ -f "$ROOT/scripts/catalog-health-check.ts" ] || {
    echo "[yugcontract-health] FAILED: scripts/catalog-health-check.ts missing"; exit 4;
}

# Pass the classification exit code (0/1/2) through to systemd unchanged.
exec node scripts/catalog-health-check.ts
