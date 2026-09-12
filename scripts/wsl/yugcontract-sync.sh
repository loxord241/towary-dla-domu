#!/usr/bin/env bash
# WSL/Linux launcher for the EXISTING Yugcontract sync.
#
# Phase 1 — products/prices: the UNCHANGED canonical importer
#   node scripts/yugcontract-import-run.ts --run
# Phase 2 — supplier content (descriptions + specifications): the EXISTING
#   two-stage content importer, run only after phase 1 succeeded:
#   node scripts/yugcontract-content-fetch.ts --stage   (one get-content-goods call → staging)
#   node scripts/yugcontract-content-apply.ts --run     (diff-aware batches → products)
# Phase 3 — product images (hotlink): the EXISTING images importer, run only
#   after phase 2 succeeded (staging must be fresh):
#   node scripts/yugcontract-content-images.ts --run    (diff-aware batches → product_images)
# No new importer logic lives here — all phases are the production scripts.
# Credentials come ONLY from the repo-local .env.local, which the importers
# themselves read. No secrets are passed as arguments and none are printed.
#
# Designed to be invoked by the systemd timer (see
# scripts/wsl/install-yugcontract-timer.sh) or manually.
#
# Exit codes:
#   0    sync OK (or skipped: another sync is running, or the importer's 48h
#        DB gate skipped the products phase — gate skips never stamp success)
#   1    importer exited non-zero (propagated)
#   2    node not found
#   3    node too old (need v24+, native TS support)
#   4    .env.local missing in repo root
#   5    importer script missing
#   6    cannot cd into repo root
#   7    coreutils 'timeout' not found
#   10   cannot create logs dir
#   124  a phase exceeded its hard timeout and was killed (GNU timeout code);
#        explicit log message + non-zero exit so systemd OnFailure / CI callers
#        see the failure instead of a hung flock
#
# Usage: yugcontract-sync.sh [--force]
#   --force bypasses the 48h interval gate (explicit owner request); flock,
#   logging and all other guards still apply. Default keeps the gate.
#
# Timeouts: every importer phase runs under `timeout` (default 30m, override
# with YUGCONTRACT_SYNC_TIMEOUT_SECS). A full sync takes minutes (see
# docs/wsl-sync.md §7); 30m leaves a wide margin while guaranteeing the flock
# is eventually released.
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
[ -f "$ROOT/scripts/yugcontract-content-images.ts" ] || { echo "[yugcontract-sync] FAILED: content images script missing"; exit 5; }

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
    # Optional $1: extra capture file (receives ONLY redacted lines) so the
    # launcher can inspect phase output without re-reading the daily log.
    awk '{
        if ($0 ~ /^[A-Z0-9_]+[ \t]*=/) print "[redacted env-like line]";
        else if (tolower($0) ~ /requesttoken|authtoken|authorization|bearer[[:space:]]|token=|bot[0-9]+:/) print "[redacted token-bearing line]";
        else print;
    }' | tee -a "$LOG" "${1:-/dev/null}"
}

# Hard per-phase timeout. Without it a hung importer kept the flock forever
# and every later trigger silently exited 0 (owner never learned the sync was
# stuck). 1800s default: a full sync takes minutes (docs/wsl-sync.md §7), so
# 30m is a wide margin. `timeout` exits 124 when it kills the process.
SYNC_TIMEOUT_SECS="${YUGCONTRACT_SYNC_TIMEOUT_SECS:-1800}"
command -v timeout >/dev/null 2>&1 || { echo "[yugcontract-sync] FAILED: coreutils 'timeout' not found (needed for the per-phase timeout guard)"; exit 7; }
run_phase() {
    # run_phase <capture-file> <cmd...> — streams output through log_pipe and
    # returns the command's own exit code (124 on timeout).
    local capture="$1"; shift
    timeout "$SYNC_TIMEOUT_SECS" "$@" 2>&1 | log_pipe "$capture"
    return "${PIPESTATUS[0]}"
}

# Phase timed out → loud, non-zero failure (systemd OnFailure / CI see it).
phase_timeout_exit() {
    echo "[yugcontract-sync] FAILED: $1 TIMED OUT after ${SYNC_TIMEOUT_SECS}s and was killed"
    echo "[yugcontract-sync] (a hung run used to hold the flock forever; the next trigger would silently skip)"
    echo "[yugcontract-sync] crashed runs can be resumed with:"
    echo "    $2"
    exit 124
}

# The importer's 48h DB gate prints this marker and exits 0 WITHOUT doing any
# work (scripts/yugcontract-import-run.ts). The last-success stamp must NOT be
# refreshed for such runs, otherwise the real working-sync interval stretches
# to ~4 days (stamp re-arms 47h + DB gate another 47h).
GATE_SKIP_MARKER='skipping (< 48h interval):'
CAPTURE="$(mktemp "$LOGS/.yugcontract-sync-capture.XXXXXX")"
trap 'rm -f "$CAPTURE"' EXIT

run_phase "$CAPTURE" node scripts/yugcontract-import-run.ts --run ${FORCE:+--force}

RC=$?
if [ "$RC" -eq 124 ]; then
    phase_timeout_exit "products importer" "node scripts/yugcontract-import-run.ts --run --resume <RUN_ID from log>"
fi
if [ "$RC" -ne 0 ]; then
    echo "[yugcontract-sync] importer exited with code $RC"
    echo "[yugcontract-sync] crashed runs can be resumed with:"
    echo "    node scripts/yugcontract-import-run.ts --run --resume <RUN_ID from log>"
    exit "$RC"
fi

GATE_SKIPPED=0
if grep -qF "$GATE_SKIP_MARKER" "$CAPTURE"; then
    GATE_SKIPPED=1
    echo "[yugcontract-sync] products phase skipped by the importer's 48h DB gate — last-success stamp will NOT be updated"
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
run_phase /dev/null node scripts/yugcontract-content-fetch.ts --stage
FETCH_RC=$?
if [ "$FETCH_RC" -eq 124 ]; then
    phase_timeout_exit "content fetch" "node scripts/yugcontract-content-fetch.ts --stage"
fi
if [ "$FETCH_RC" -ne 0 ]; then
    echo "[yugcontract-sync] content fetch exited with code $FETCH_RC — apply skipped"
    echo "[yugcontract-sync] (products/price phase above DID complete; content will retry on the next sync)"
    exit "$FETCH_RC"
fi

echo "[yugcontract-sync] content phase: apply --run"
run_phase /dev/null node scripts/yugcontract-content-apply.ts --run
APPLY_RC=$?
if [ "$APPLY_RC" -eq 124 ]; then
    phase_timeout_exit "content apply" "node scripts/yugcontract-content-apply.ts --run --resume <RUN_ID from log>"
fi
if [ "$APPLY_RC" -ne 0 ]; then
    echo "[yugcontract-sync] content apply exited with code $APPLY_RC"
    echo "[yugcontract-sync] crashed content runs can be resumed with:"
    echo "    node scripts/yugcontract-content-apply.ts --run --resume <RUN_ID from log>"
    exit "$APPLY_RC"
fi

# --- images phase (product_images hotlink) -------------------------------------
# The EXISTING images importer, invoked exactly once per sync:
#   images --run : diff-aware checkpointed batches over staging
#                  (yc_content_goods.pictures) → writes ONLY product_images
#                  as external hotlink URLs (manual Storage rows untouched;
#                  deletions intentionally NOT implemented; resumable).
# Ordering guard: runs ONLY after fetch + apply exited 0 — the staging the
# image URLs come from must be a fresh snapshot. Products/content phase
# failures above already exit before this point.
echo "[yugcontract-sync] images phase: content-images --run"
run_phase /dev/null node scripts/yugcontract-content-images.ts --run
IMAGES_RC=$?
if [ "$IMAGES_RC" -eq 124 ]; then
    phase_timeout_exit "images importer" "node scripts/yugcontract-content-images.ts --run --resume <RUN_ID from log>"
fi
if [ "$IMAGES_RC" -ne 0 ]; then
    echo "[yugcontract-sync] images importer exited with code $IMAGES_RC"
    echo "[yugcontract-sync] (products/content phases above DID complete; images will retry on the next sync)"
    echo "[yugcontract-sync] crashed images runs can be resumed with:"
    echo "    node scripts/yugcontract-content-images.ts --run --resume <RUN_ID from log>"
    exit "$IMAGES_RC"
fi

# Stamp success for the 48h interval guard — ONLY when the products import
# actually RAN and all phases succeeded. A run skipped by the importer's 48h
# DB gate did no work; stamping it would re-arm the local gate from "now" and
# stretch the real working-sync interval to ~4 days (47h stamp + 47h DB gate).
# Failed runs are also NOT stamped, so the next daily trigger will retry (the
# products re-run is diff-aware and costs ~2 min).
if [ "$GATE_SKIPPED" -eq 1 ]; then
    echo "[yugcontract-sync] done OK (products phase was 48h-gate-skipped; last-success stamp NOT updated)"
    exit 0
fi
date +%s > "$LAST_STAMP"
echo "[yugcontract-sync] done OK"
exit 0
