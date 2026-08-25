#!/usr/bin/env bash
# Reliable dev-server restart for the storefront.
#
# Why this exists: `npm start` spawns a process tree (npm → next start →
# next-server). Killing the npm parent leaves the next-server child alive,
# still holding :3000 and serving a STALE build with stale DB connections
# (observed 2026-08: EADDRINUSE + intermittently empty catalog in Playwright
# runs). This script kills whatever holds the port, verifies the port is
# actually free, and only then starts a fresh server.
#
# Usage: scripts/dev-restart.sh [port]   (default 3000)
set -euo pipefail

PORT="${1:-3000}"

pids_on_port() {
  ss -tlnp "sport = :$PORT" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true
}

pids="$(pids_on_port)"
if [ -n "$pids" ]; then
  echo "stopping stale server on :$PORT (pids: $pids)"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 1
  # graceful kill may leave the child alive — force after a grace period
  pids="$(pids_on_port)"
  if [ -n "$pids" ]; then
    echo "force-killing leftovers (pids: $pids)"
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
    sleep 1
  fi
fi

if ss -tln "sport = :$PORT" | grep -q ":$PORT"; then
  echo "ERROR: port $PORT is still in use — refusing to start a duplicate server" >&2
  exit 1
fi

echo "port $PORT is free — starting npm start"
exec npm start
