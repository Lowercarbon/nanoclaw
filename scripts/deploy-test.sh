#!/bin/bash
# Full deploy cycle for testing NanoClaw changes.
# Busts Docker cache, clears agent sessions, restarts the service.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Resolve the real project root — if running from a git worktree, follow
# the .git file back to the main repo so we find store/messages.db.
WORKTREE_DIR="$(dirname "$SCRIPT_DIR")"
if [ -f "$WORKTREE_DIR/.git" ]; then
  # .git is a file (not dir) in worktrees — it contains "gitdir: /path/to/main/.git/worktrees/..."
  MAIN_GIT_DIR="$(sed 's/^gitdir: //' "$WORKTREE_DIR/.git" | sed 's|/\.git/worktrees/.*||')"
  PROJECT_DIR="$MAIN_GIT_DIR"
else
  PROJECT_DIR="$WORKTREE_DIR"
fi

echo "=== Building container (no cache) ==="
# Build from the script's own repo (may be a worktree with newer code)
docker build --no-cache -t nanoclaw-agent:latest -f "$WORKTREE_DIR/container/Dockerfile" "$WORKTREE_DIR/container/"

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
