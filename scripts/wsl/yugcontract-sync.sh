#!/usr/bin/env bash
# WSL/Linux launcher for the EXISTING Yugcontract sync.
#
# Phase 1 — products/prices: the UNCHANGED canonical importer
#   node scripts/yugcontract-import-run.ts --run
# Phase 2 — supplier content (descriptions + specifications): the EXISTING
#   two-stage content importer, run only after phase 1 succeeded:
#   node scripts/yugcontract-content-fetch.ts --stage   (one get-content-goods call → staging)
#   node scripts/yugcontract-content-apply.ts --run     (diff-aware batches → products)
# No new importer logic lives here — both phases are the production scripts.
# Credentials come ONLY from the repo-local .env.local, which the importers
# themselves read. No secrets are passed as arguments and none are printed.
#
# Designed to be invoked by the systemd timer (see
# scripts/wsl/install-yugcontract-timer.sh) or manually.
#
# Exit codes:
#   0   sync OK (or skipped because another sync is already running)
#   1   importer exited non-zero (propagated)
#   2   node not found
#   3   node too old (need v24+, native TS support)
#   4   .env.local missing in repo root
#   5   importer script missing
#   6  cannot cd into repo root
#   10  cannot create logs dir
#
# Usage: yugcontract-sync.sh [--force]
#   --force bypasses the 48h interval gate (explicit owner request); flock,
#   logging and all other guards still apply. Default keeps the gate.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || { echo "[yugcontract-sync] cannot cd into $ROOT"; exit 6; }

# --- node resolution (nvm installs are not on systemd's default PATH) ---------
if ! command -v node >/dev/null 2>&1; then
    for d in "$HOME"/.nvm/versions/node/v*; do
        if [ -x "$d/bin/node" ]; then
            export PATH="$d/bin:$PATH"
            break
        fi
    done
fi
if ! command -v node >/dev/null 2>&1; then
    echo "[yugcontract-sync] FAILED: node not found (install Node 24 LTS or nvm default)"
    exit 2
fi

NODE_VERSION="$(node --version)"
echo "[yugcontract-sync] node $NODE_VERSION"
case "$NODE_VERSION" in
    v2[4-9].*|v[3-9][0-9].*) ;;
    *) echo "[yugcontract-sync] FAILED: Node v24+ required, found $NODE_VERSION"; exit 3 ;;
esac

# --- preflight ----------------------------------------------------------------
[ -f "$ROOT/.env.local" ] || { echo "[yugcontract-sync] FAILED: .env.local not found in $ROOT"; exit 4; }
[ -f "$ROOT/scripts/yugcontract-import-run.ts" ] || { echo "[yugcontract-sync] FAILED: importer script missing"; exit 5; }
[ -f "$ROOT/scripts/yugcontract-content-fetch.ts" ] || { echo "[yugcontract-sync] FAILED: content fetch script missing"; exit 5; }
[ -f "$ROOT/scripts/yugcontract-content-apply.ts" ] || { echo "[yugcontract-sync] FAILED: content apply script missing"; exit 5; }

# --- logs: dir, daily file, ~14 day rotation ----------------------------------
LOGS="$ROOT/logs"
mkdir -p "$LOGS" || { echo "[yugcontract-sync] FAILED: cannot create $LOGS"; exit 10; }
LOG="$LOGS/yugcontract-sync-$(date +%Y%m%d).log"
find "$LOGS" -name 'yugcontract-sync-*.log' -mtime +14 -delete 2>/dev/null || true

# --- single-instance guard (extra to systemd's own serialization) -------------
exec 9>"$LOGS/.yugcontract-sync.lock"
if ! flock -n 9; then
    echo "[yugcontract-sync] another sync is already running — skipping (no overlap)"
    exit 0
fi

# --- 48h interval guard --------------------------------------------------------
# The systemd timer fires daily at 18:00 (fixed-time anchor + Persistent
# catch-up), but the REAL requirement is a 48h interval between syncs —
# systemd OnCalendar cannot express "every 48 hours" without day-of-month
# hacks that break on month boundaries. So the launcher enforces the true
# interval via a success stamp: runs happen at most once per 47h+.
# --force (explicit owner/agent request) skips ONLY this gate.
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1
LAST_STAMP="$LOGS/.yugcontract-last-success"
if [ "$FORCE" -eq 1 ]; then
    echo "[yugcontract-sync] --force: 48h interval gate bypassed by explicit request"
elif [ -f "$LAST_STAMP" ]; then
    AGE_H=$(( ( $(date +%s) - $(stat -c %Y "$LAST_STAMP") ) / 3600 ))
    if [ "$AGE_H" -lt 47 ]; then
        echo "[yugcontract-sync] last successful sync was $AGE_H h ago (< 48h interval) — skipping this trigger"
        exit 0
    fi
fi

echo "[yugcontract-sync] start $(date -Is)"
echo "[yugcontract-sync] log: $LOG"

# --- canonical sync -----------------------------------------------------------
# Defensive scrub so no env-like or token-bearing line can reach the log/journal.
set -o pipefail
log_pipe() {
    awk '{
        if ($0 ~ /^[A-Z0-9_]+[ \t]*=/) print "[redacted env-like line]";
        else if (tolower($0) ~ /requesttoken|authtoken|authorization|bearer[[:space:]]|token=|bot[0-9]+:/) print "[redacted token-bearing line]";
        else print;
    }' | tee -a "$LOG"
}

node scripts/yugcontract-import-run.ts --run ${FORCE:+--force} 2>&1 | log_pipe

RC=${PIPESTATUS[0]}
if [ "$RC" -ne 0 ]; then
    echo "[yugcontract-sync] importer exited with code $RC"
    echo "[yugcontract-sync] crashed runs can be resumed with:"
    echo "    node scripts/yugcontract-import-run.ts --run --resume <RUN_ID from log>"
    exit "$RC"
fi

# --- content phase (description + specifications) ------------------------------
# The EXISTING two-stage content importer, invoked exactly once per sync:
#   fetch --stage : ONE full get-content-goods call → upsert yc_content_goods
#                   (staging only; product_images is never touched here)
#   apply --run   : diff-aware checkpointed batches over staging → writes ONLY
#                   products.description + products.specifications
#                   (assertContentFields guard; empty-HTML supplier shells
#                   excluded; identical values are no-ops; resumable).
# Ordering guard: apply runs ONLY after fetch exited 0 — it never applies a
# stale snapshot on top of a failed refresh. Products phase failure above
# already exits before this point.
echo "[yugcontract-sync] content phase: fetch --stage"
node scripts/yugcontract-content-fetch.ts --stage 2>&1 | log_pipe
FETCH_RC=${PIPESTATUS[0]}
if [ "$FETCH_RC" -ne 0 ]; then
    echo "[yugcontract-sync] content fetch exited with code $FETCH_RC — apply skipped"
    echo "[yugcontract-sync] (products/price phase above DID complete; content will retry on the next sync)"
    exit "$FETCH_RC"
fi

echo "[yugcontract-sync] content phase: apply --run"
node scripts/yugcontract-content-apply.ts --run 2>&1 | log_pipe
APPLY_RC=${PIPESTATUS[0]}
if [ "$APPLY_RC" -ne 0 ]; then
    echo "[yugcontract-sync] content apply exited with code $APPLY_RC"
    echo "[yugcontract-sync] crashed content runs can be resumed with:"
    echo "    node scripts/yugcontract-content-apply.ts --run --resume <RUN_ID from log>"
    exit "$APPLY_RC"
fi

# stamp success for the 48h interval guard — only when ALL phases succeeded
# (failed runs are NOT stamped, so the next daily trigger will retry; the
# products re-run is diff-aware and costs ~2 min).
date +%s > "$LAST_STAMP"
echo "[yugcontract-sync] done OK"
exit 0
