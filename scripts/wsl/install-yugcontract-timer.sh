#!/usr/bin/env bash
# Registers a systemd timer (inside WSL2 with systemd enabled) that runs the
# Yugcontract sync via the existing launcher: systemd fires daily at 18:00,
# the launcher enforces the real 48h interval between successful syncs.
#
# Idempotent: re-running overwrites the unit files and re-enables the timer
# (no duplicates).
#
# The units contain NO secrets — the service only executes the launcher;
# credentials stay in the repo-local .env.local.
#
# Usage:  bash scripts/wsl/install-yugcontract-timer.sh        (needs sudo)
# Status: systemctl status yugcontract-sync.timer
# Stop:   sudo systemctl disable --now yugcontract-sync.timer
# Remove: sudo systemctl disable --now yugcontract-sync.timer && \
#         sudo rm /etc/systemd/system/yugcontract-sync.{service,timer}
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LAUNCHER="$ROOT/scripts/wsl/yugcontract-sync.sh"
UNIT_DIR="/etc/systemd/system"
RUN_USER="${SUDO_USER:-$USER}"

[ -f "$LAUNCHER" ] || { echo "launcher not found: $LAUNCHER"; exit 1; }
chmod +x "$LAUNCHER"
[ -f "$ROOT/scripts/wsl/yugcontract-failure-notify.sh" ] && chmod +x "$ROOT/scripts/wsl/yugcontract-failure-notify.sh"
[ -f "$ROOT/scripts/wsl/yugcontract-health.sh" ] && chmod +x "$ROOT/scripts/wsl/yugcontract-health.sh"
[ -f "$ROOT/scripts/catalog-health-check.ts" ] || { echo "health-check script not found"; exit 1; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

# --- service: oneshot, runs as the repo owner (root-owned logs are ugly) ------
$SUDO tee "$UNIT_DIR/yugcontract-sync.service" > /dev/null <<EOF
[Unit]
Description=Yugcontract daily price/stock sync (canonical importer)
Wants=network-online.target
After=network-online.target
# Monitoring (2026-08-28): a failed sync starts the local failure handler
# (log + optional webhook). The importer/launcher themselves are unchanged.
OnFailure=yugcontract-sync-failure.service

[Service]
Type=oneshot
User=$RUN_USER
WorkingDirectory=$ROOT
ExecStart=$LAUNCHER
# one run at a time is guaranteed by Type=oneshot + the launcher's flock;
# results are also visible in the journal: journalctl -u yugcontract-sync
EOF

# --- failure handler: local log always, webhook only if configured -----------
$SUDO tee "$UNIT_DIR/yugcontract-sync-failure.service" > /dev/null <<EOF
[Unit]
Description=Record/notify a failed Yugcontract sync (no secrets sent)

[Service]
Type=oneshot
User=$RUN_USER
WorkingDirectory=$ROOT
# Optional outbound channel: YUGCONTRACT_ALERT_WEBHOOK_URL in .env.local.
# The file is loaded read-only by the script; nothing is printed.
EnvironmentFile=-$ROOT/.env.local
ExecStart=$ROOT/scripts/wsl/yugcontract-failure-notify.sh %n
EOF

# --- post-sync health check: read-only catalog/sync diagnostics --------------
$SUDO tee "$UNIT_DIR/yugcontract-health.service" > /dev/null <<EOF
[Unit]
Description=Read-only catalog health check (PASS/WARN/FAIL exit 0/1/2)
# Runs after the sync attempt: if the sync itself is still in flight the
# stuck-batch check simply stays quiet; a crashed sync is caught by
# OnFailure above and by the last-success age check here.
After=yugcontract-sync.service

[Service]
Type=oneshot
User=$RUN_USER
WorkingDirectory=$ROOT
# nvm node is invisible to systemd (no interactive shell) — the launcher
# resolves Node the same proven way as yugcontract-sync.sh.
ExecStart=$ROOT/scripts/wsl/yugcontract-health.sh
# Health classification exit codes: WARN=1 is an EXPECTED outcome (degraded
# catalog data), not a unit failure. FAIL=2 and launcher errors (3/4) stay
# failures so a broken sync/import still shows up as "failed" in systemd.
SuccessExitStatus=1
EOF

$SUDO tee "$UNIT_DIR/yugcontract-health.timer" > /dev/null <<EOF
[Unit]
Description=Daily 18:45 read-only health check (after the 18:00 sync window)

[Timer]
OnCalendar=*-*-* 18:45:00
Persistent=true
Unit=yugcontract-health.service

[Install]
WantedBy=timers.target
EOF

# --- timer: 18:00 local (WSL mirrors the Windows clock/timezone) ---------------
# Persistent=true: if the machine/WSL was down at 18:00, systemd fires the
# missed run ONCE at the next WSL start (no double runs).
$SUDO tee "$UNIT_DIR/yugcontract-sync.timer" > /dev/null <<EOF
[Unit]
Description=Daily 18:00 trigger for Yugcontract sync (48h interval enforced by launcher)

[Timer]
OnCalendar=*-*-* 18:00:00
Persistent=true
Unit=yugcontract-sync.service

[Install]
WantedBy=timers.target
EOF

$SUDO systemctl daemon-reload
$SUDO systemctl enable --now yugcontract-sync.timer
# Health check timer: daily 18:45 (after the 18:00 sync window) + manual runs
# via `systemctl start yugcontract-health.service`.
$SUDO systemctl enable --now yugcontract-health.timer

echo "[install] timers registered:"
systemctl list-timers yugcontract-sync.timer yugcontract-health.timer --no-pager
echo "[install] next trigger: $(systemctl show yugcontract-sync.timer -p NextElapseUSecRealtime --value)"
