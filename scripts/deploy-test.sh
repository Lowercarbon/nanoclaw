#!/bin/bash
# Full deploy cycle for testing NanoClaw changes.
# Busts Docker cache, clears agent sessions, restarts the service.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Building container (no cache) ==="
docker build --no-cache -t nanoclaw-agent:latest -f "$PROJECT_DIR/container/Dockerfile" "$PROJECT_DIR/container/"

echo ""
echo "=== Clearing agent sessions ==="
DB_PATH="$PROJECT_DIR/store/messages.db"
if [ -f "$DB_PATH" ]; then
  CLEARED=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sessions;")
  sqlite3 "$DB_PATH" "DELETE FROM sessions;"
  echo "Cleared $CLEARED session(s)"
else
  echo "No database found at $DB_PATH, skipping"
fi

echo ""
echo "=== Restarting NanoClaw ==="
if launchctl kickstart -k "gui/$(id -u)/com.nanoclaw" 2>/dev/null; then
  echo "Service restarted (launchd)"
elif systemctl --user restart nanoclaw 2>/dev/null; then
  echo "Service restarted (systemd)"
else
  echo "Could not restart service — restart manually"
fi

echo ""
echo "=== Deploy complete ==="
echo "Next message will start a fresh agent session."
