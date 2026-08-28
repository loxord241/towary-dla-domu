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

SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

# --- service: oneshot, runs as the repo owner (root-owned logs are ugly) ------
$SUDO tee "$UNIT_DIR/yugcontract-sync.service" > /dev/null <<EOF
[Unit]
Description=Yugcontract daily price/stock sync (canonical importer)
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=$RUN_USER
WorkingDirectory=$ROOT
ExecStart=$LAUNCHER
# one run at a time is guaranteed by Type=oneshot + the launcher's flock;
# results are also visible in the journal: journalctl -u yugcontract-sync
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

echo "[install] timer registered:"
systemctl list-timers yugcontract-sync.timer --no-pager
echo "[install] next trigger: $(systemctl show yugcontract-sync.timer -p NextElapseUSecRealtime --value)"
