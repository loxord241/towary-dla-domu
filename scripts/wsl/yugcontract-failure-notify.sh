#!/usr/bin/env bash
# OnFailure handler for yugcontract-sync.service (installed by
# install-yugcontract-timer.sh). systemd starts this unit when the sync
# fails; the FAILED unit name arrives as $1.
#
# Notification model (audit 2026-08-28):
#  - ALWAYS: appends a timestamped record to logs/yugcontract-failures.log
#    and keeps a single status file logs/.yugcontract-last-failure —
#    reliable local detection with zero external dependencies;
#  - OPTIONAL: if YUGCONTRACT_ALERT_WEBHOOK_URL is set (in .env.local or the
#    environment), a short JSON payload is POSTed via curl (10s timeout).
#    There is NO mail/SMTP/Telegram in this WSL by default — the webhook is
#    the only outbound channel and it stays a no-op until the user provides
#    a URL. No secrets are ever included in the payload.
#
# This script NEVER fails the notification chain: it always exits 0.
set -u

FAILED_UNIT="${1:-unknown-unit}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOGS="$ROOT/logs"
mkdir -p "$LOGS" 2>/dev/null || true

TS="$(date -Is)"
RECORD="$TS unit=$FAILED_UNIT"
echo "$RECORD" >> "$LOGS/yugcontract-failures.log"
printf '%s\n' "$TS" > "$LOGS/.yugcontract-last-failure" 2>/dev/null || true

# Optional generic webhook (Slack/Discord/Telegram gateway/self-hosted …).
# The URL may contain secrets — it is never printed or logged.
URL="${YUGCONTRACT_ALERT_WEBHOOK_URL:-}"
if [ -z "$URL" ] && [ -f "$ROOT/.env.local" ]; then
    URL="$(sed -n 's/^\s*YUGCONTRACT_ALERT_WEBHOOK_URL\s*=\s*//p' "$ROOT/.env.local" | head -n1 | tr -d '\"' | tr -d "'")"
fi
if [ -n "$URL" ]; then
    curl -fsS --max-time 10 -H 'Content-Type: application/json' \
        -d "{\"text\":\"yugcontract-sync FAILED: unit=$FAILED_UNIT at $TS\"}" \
        "$URL" >/dev/null 2>&1 || echo "[failure-notify] webhook delivery failed (non-fatal)"
fi

exit 0
