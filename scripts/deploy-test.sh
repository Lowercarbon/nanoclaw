#!/bin/bash
# Interactive deploy helper for NanoClaw test deploys.
# Lets you choose build depth separately from runtime reset depth.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Resolve the real project root — if running from a git worktree, follow
# the .git file back to the main repo so we find store/messages.db.
WORKTREE_DIR="$(dirname "$SCRIPT_DIR")"
if [ -f "$WORKTREE_DIR/.git" ]; then
  # .git is a file (not dir) in worktrees — it contains
  # "gitdir: /path/to/main/.git/worktrees/..."
  MAIN_GIT_DIR="$(sed 's/^gitdir: //' "$WORKTREE_DIR/.git" | sed 's|/\.git/worktrees/.*||')"
  PROJECT_DIR="$MAIN_GIT_DIR"
else
  PROJECT_DIR="$WORKTREE_DIR"
fi

BUILD_MODE="${NANOCLAW_BUILD_MODE:-}"
RESET_MODE="${NANOCLAW_RESET_MODE:-}"
HOST_BUILD_MODE="${NANOCLAW_HOST_BUILD_MODE:-}"
HOST_BUILD_RECOMMENDATION=""
HOST_BUILD_REASON=""
HOST_BUILD_WARNING=""
CHANGE_SOURCE=""

usage() {
  cat <<'EOF'
Usage:
  ./scripts/deploy-test.sh
  ./scripts/deploy-test.sh --build-mode restart|cached|full --reset-mode keep|memory|attachments|full --host-build skip|build

Build modes:
  restart       Restart NanoClaw only. No Docker rebuild.
  cached        Rebuild the container image with Docker cache (recommended).
  full          Rebuild the container image with --no-cache (slowest).

Reset modes:
  keep          Keep runtime state as-is.
  memory        Clear Claude session memory only.
  attachments   Clear session memory + saved attachment artifacts.
  full          Clear session memory + attachments + archived conversations.

Host build:
  skip          Do not run npm run build for the host app.
  build         Rebuild host dist/ and sync it into the live project.

Notes:
  - The script still syncs cached agent-runner source from the current worktree.
  - The script can recommend whether host build is needed based on your recent changes.
EOF
}

validate_build_mode() {
  case "$1" in
    restart|cached|full) ;;
    *)
      echo "Invalid build mode: $1" >&2
      usage
      exit 1
      ;;
  esac
}

validate_reset_mode() {
  case "$1" in
    keep|memory|attachments|full) ;;
    *)
      echo "Invalid reset mode: $1" >&2
      usage
      exit 1
      ;;
  esac
}

validate_host_build_mode() {
  case "$1" in
    skip|build) ;;
    *)
      echo "Invalid host build mode: $1" >&2
      usage
      exit 1
      ;;
  esac
}

describe_build_mode() {
  case "$1" in
    restart)
      echo "Restart only — no Docker rebuild. Good for state-only retests or prompt changes already on disk."
      ;;
    cached)
      echo "Cached container rebuild — recommended for most day-to-day code changes."
      ;;
    full)
      echo "No-cache container rebuild — use after major container/runtime/MCP architecture changes or when cache looks suspect."
      ;;
  esac
}

describe_reset_mode() {
  case "$1" in
    keep)
      echo "Keep runtime state — no sessions or files cleared."
      ;;
    memory)
      echo "Clear Claude session memory only — good for formatting/prompt retests."
      ;;
    attachments)
      echo "Clear session memory + saved attachment artifacts — good for download/send verification."
      ;;
    full)
      echo "Clear session memory + attachments + archived conversations — closest thing to a clean slate."
      ;;
  esac
}

describe_host_build_mode() {
  case "$1" in
    skip)
      echo "Skip host dist rebuild. Use when changes are container-only or state-only."
      ;;
    build)
      echo "Run npm run build for the host app and sync dist/ into the live project."
      ;;
  esac
}

preview_paths() {
  local limit="$1"
  shift

  local count=0
  local joined=""
  local file
  for file in "$@"; do
    if [ -z "$file" ]; then
      continue
    fi
    if [ "$count" -gt 0 ]; then
      joined="$joined, "
    fi
    joined="$joined$file"
    count=$((count + 1))
    if [ "$count" -ge "$limit" ]; then
      break
    fi
  done

  if [ "$#" -gt "$limit" ]; then
    joined="$joined, ..."
  fi

  echo "$joined"
}

detect_host_build_recommendation() {
  local changed_files=()
  local tracked_changes=()
  local host_runtime_files=()
  local host_dependency_files=()
  local container_files=()
  local file

  while IFS= read -r file; do
    [ -n "$file" ] && tracked_changes+=("$file")
  done < <(
    {
      git -C "$WORKTREE_DIR" diff --name-only
      git -C "$WORKTREE_DIR" diff --cached --name-only
      git -C "$WORKTREE_DIR" ls-files --others --exclude-standard
    } | sed '/^$/d' | sort -u
  )

  if [ "${#tracked_changes[@]}" -gt 0 ]; then
    CHANGE_SOURCE="working tree"
    changed_files=("${tracked_changes[@]}")
  else
    CHANGE_SOURCE="HEAD commit"
    while IFS= read -r file; do
      [ -n "$file" ] && changed_files+=("$file")
    done < <(git -C "$WORKTREE_DIR" show --name-only --pretty='' HEAD | sed '/^$/d')
  fi

  for file in "${changed_files[@]}"; do
    case "$file" in
      src/*|tsconfig.json|tsconfig.*.json)
        host_runtime_files+=("$file")
        ;;
      package.json|package-lock.json)
        host_dependency_files+=("$file")
        ;;
      container/*)
        container_files+=("$file")
        ;;
    esac
  done

  HOST_BUILD_WARNING=""

  if [ "${#host_runtime_files[@]}" -gt 0 ]; then
    HOST_BUILD_RECOMMENDATION="build"
    HOST_BUILD_REASON="Detected host runtime changes in $CHANGE_SOURCE: $(preview_paths 4 "${host_runtime_files[@]}")"
  elif [ "${#host_dependency_files[@]}" -gt 0 ]; then
    HOST_BUILD_RECOMMENDATION="build"
    HOST_BUILD_REASON="Detected host dependency/config changes in $CHANGE_SOURCE: $(preview_paths 4 "${host_dependency_files[@]}")"
    HOST_BUILD_WARNING="package.json/package-lock changes may also require dependency sync in the live project."
  elif [ "${#container_files[@]}" -gt 0 ]; then
    HOST_BUILD_RECOMMENDATION="skip"
    HOST_BUILD_REASON="Changes look container-only in $CHANGE_SOURCE: $(preview_paths 4 "${container_files[@]}")"
  else
    HOST_BUILD_RECOMMENDATION="skip"
    if [ "${#changed_files[@]}" -gt 0 ]; then
      HOST_BUILD_REASON="No host runtime files detected in $CHANGE_SOURCE."
    else
      HOST_BUILD_REASON="No recent file changes detected."
    fi
  fi
}

prompt_build_mode() {
  if [ -n "$BUILD_MODE" ]; then
    validate_build_mode "$BUILD_MODE"
    return
  fi

  if [ ! -t 0 ]; then
    echo "No TTY available. Pass --build-mode and --reset-mode explicitly." >&2
    exit 1
  fi

  echo "=== Choose build mode ==="
  echo "  1) restart   Restart only"
  echo "     $(describe_build_mode restart)"
  echo "  2) cached    Cached container rebuild"
  echo "     $(describe_build_mode cached)"
  echo "  3) full      No-cache container rebuild"
  echo "     $(describe_build_mode full)"

  while true; do
    read -r -p "Build mode [1-3]: " choice
    case "$choice" in
      1) BUILD_MODE="restart"; return ;;
      2) BUILD_MODE="cached"; return ;;
      3) BUILD_MODE="full"; return ;;
      *) echo "Please enter 1, 2, or 3." ;;
    esac
  done
}

prompt_reset_mode() {
  if [ -n "$RESET_MODE" ]; then
    validate_reset_mode "$RESET_MODE"
    return
  fi

  if [ ! -t 0 ]; then
    echo "No TTY available. Pass --build-mode and --reset-mode explicitly." >&2
    exit 1
  fi

  echo ""
  echo "=== Choose reset mode ==="
  echo "  1) keep         Keep runtime state"
  echo "     $(describe_reset_mode keep)"
  echo "  2) memory       Clear session memory only"
  echo "     $(describe_reset_mode memory)"
  echo "  3) attachments  Clear memory + attachment artifacts"
  echo "     $(describe_reset_mode attachments)"
  echo "  4) full         Clear memory + attachments + conversations"
  echo "     $(describe_reset_mode full)"

  while true; do
    read -r -p "Reset mode [1-4]: " choice
    case "$choice" in
      1) RESET_MODE="keep"; return ;;
      2) RESET_MODE="memory"; return ;;
      3) RESET_MODE="attachments"; return ;;
      4) RESET_MODE="full"; return ;;
      *) echo "Please enter 1, 2, 3, or 4." ;;
    esac
  done
}

prompt_host_build_mode() {
  detect_host_build_recommendation

  if [ -n "$HOST_BUILD_MODE" ]; then
    validate_host_build_mode "$HOST_BUILD_MODE"
    return
  fi

  if [ ! -t 0 ]; then
    HOST_BUILD_MODE="$HOST_BUILD_RECOMMENDATION"
    return
  fi

  echo ""
  echo "=== Choose host build mode ==="
  echo "Recommendation: $HOST_BUILD_RECOMMENDATION"
  echo "Reason:         $HOST_BUILD_REASON"
  if [ -n "$HOST_BUILD_WARNING" ]; then
    echo "Warning:        $HOST_BUILD_WARNING"
  fi
  echo "  1) skip"
  echo "     $(describe_host_build_mode skip)"
  echo "  2) build"
  echo "     $(describe_host_build_mode build)"

  local prompt_text="Host build [1-2]"
  if [ "$HOST_BUILD_RECOMMENDATION" = "build" ]; then
    prompt_text="$prompt_text (Enter = 2)"
  else
    prompt_text="$prompt_text (Enter = 1)"
  fi
  prompt_text="$prompt_text: "

  while true; do
    read -r -p "$prompt_text" choice
    case "$choice" in
      "")
        HOST_BUILD_MODE="$HOST_BUILD_RECOMMENDATION"
        return
        ;;
      1)
        HOST_BUILD_MODE="skip"
        return
        ;;
      2)
        HOST_BUILD_MODE="build"
        return
        ;;
      *)
        echo "Please enter 1 or 2."
        ;;
    esac
  done
}

confirm_plan() {
  if [ ! -t 0 ]; then
    return
  fi

  echo ""
  echo "=== Deploy plan ==="
  echo "Worktree: $WORKTREE_DIR"
  echo "Project:  $PROJECT_DIR"
  echo "Build:    $BUILD_MODE"
  echo "          $(describe_build_mode "$BUILD_MODE")"
  echo "Reset:    $RESET_MODE"
  echo "          $(describe_reset_mode "$RESET_MODE")"
  echo "Host:     $HOST_BUILD_MODE"
  echo "          $(describe_host_build_mode "$HOST_BUILD_MODE")"
  echo "Reason:   $HOST_BUILD_REASON"
  if [ -n "$HOST_BUILD_WARNING" ]; then
    echo "Warning:  $HOST_BUILD_WARNING"
  fi
  echo ""

  read -r -p "Proceed? [y/N] " confirm
  case "$confirm" in
    y|Y|yes|YES) ;;
    *)
      echo "Aborted."
      exit 1
      ;;
  esac
}

run_container_build() {
  case "$BUILD_MODE" in
    restart)
      echo "=== Skipping container build ==="
      ;;
    cached)
      echo "=== Building container (cached) ==="
      docker build --progress=plain -t nanoclaw-agent:latest -f "$WORKTREE_DIR/container/Dockerfile" "$WORKTREE_DIR/container/"
      ;;
    full)
      echo "=== Building container (no cache) ==="
      docker build --progress=plain --no-cache -t nanoclaw-agent:latest -f "$WORKTREE_DIR/container/Dockerfile" "$WORKTREE_DIR/container/"
      ;;
  esac
}

run_host_build() {
  case "$HOST_BUILD_MODE" in
    skip)
      echo ""
      echo "=== Skipping host build ==="
      ;;
    build)
      echo ""
      echo "=== Building host dist ==="
      (
        cd "$WORKTREE_DIR"
        npm run build
      )

      if [ "$WORKTREE_DIR" != "$PROJECT_DIR" ]; then
        echo ""
        echo "=== Syncing host dist into live project ==="
        rm -rf "$PROJECT_DIR/dist"
        mkdir -p "$PROJECT_DIR/dist"
        cp -R "$WORKTREE_DIR/dist/." "$PROJECT_DIR/dist"/
        echo "Synced dist/ from worktree into $PROJECT_DIR"
      fi
      ;;
  esac
}

sync_cached_agent_runner() {
  echo ""
  echo "=== Syncing cached agent-runner source ==="
  local synced=0

  for cached_dir in "$PROJECT_DIR"/data/sessions/*/agent-runner-src/; do
    if [ ! -d "$cached_dir" ]; then
      continue
    fi
    rm -rf "$cached_dir"
    mkdir -p "$cached_dir"
    cp -R "$WORKTREE_DIR"/container/agent-runner/src/. "$cached_dir"/
    echo "Synced: $cached_dir"
    synced=1
  done

  if [ "$synced" -eq 0 ]; then
    echo "No cached agent-runner directories found"
  fi
}

clear_sessions() {
  echo ""
  echo "=== Clearing agent sessions ==="
  local db_path="$PROJECT_DIR/store/messages.db"

  if [ -f "$db_path" ]; then
    local cleared
    cleared=$(sqlite3 "$db_path" "SELECT COUNT(*) FROM sessions;")
    sqlite3 "$db_path" "DELETE FROM sessions;"
    echo "Cleared $cleared session(s)"
  else
    echo "No database found at $db_path, skipping"
  fi
}

clear_attachment_artifacts() {
  echo ""
  echo "=== Clearing attachment artifacts ==="
  rm -rf "$PROJECT_DIR"/groups/*/companies/ 2>/dev/null || true
  rm -rf "$PROJECT_DIR"/data/ipc/*/files/* 2>/dev/null || true
  echo "Cleared group companies/ folders and IPC uploaded files"
}

clear_archived_conversations() {
  echo ""
  echo "=== Clearing archived conversation history ==="
  rm -rf "$PROJECT_DIR"/groups/*/conversations/ 2>/dev/null || true
  rm -rf "$PROJECT_DIR"/groups/*/company-notes/ 2>/dev/null || true
  echo "Cleared conversations/ and legacy company-notes/"
}

run_reset() {
  case "$RESET_MODE" in
    keep)
      echo ""
      echo "=== Keeping runtime state ==="
      ;;
    memory)
      clear_sessions
      ;;
    attachments)
      clear_attachment_artifacts
      clear_sessions
      ;;
    full)
      clear_attachment_artifacts
      clear_archived_conversations
      clear_sessions
      ;;
  esac
}

restart_service() {
  echo ""
  echo "=== Restarting NanoClaw ==="
  if launchctl kickstart -k "gui/$(id -u)/com.nanoclaw" 2>/dev/null; then
    echo "Service restarted (launchd)"
  elif systemctl --user restart nanoclaw 2>/dev/null; then
    echo "Service restarted (systemd)"
  else
    echo "Could not restart service — restart manually"
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --build-mode)
      BUILD_MODE="${2:-}"
      shift 2
      ;;
    --reset-mode)
      RESET_MODE="${2:-}"
      shift 2
      ;;
    --host-build)
      HOST_BUILD_MODE="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

prompt_build_mode
prompt_reset_mode
prompt_host_build_mode
confirm_plan
run_container_build
run_host_build
sync_cached_agent_runner
run_reset
restart_service

echo ""
echo "=== Deploy complete ==="
echo "Build mode: $BUILD_MODE"
echo "Reset mode: $RESET_MODE"
echo "Host build: $HOST_BUILD_MODE"
echo "Next message will use the selected reset scope."
