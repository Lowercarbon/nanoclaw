# Session Handoff: NEW_DEAL Briefings Testing (2026-04-14)

## What Was Built

Split the monolith `container/mcp-servers/google-calendar-gmail/` into 5 focused MCP servers (google, slack, lowercarbon, granola, affinity) and added NEW_DEAL stage-aware briefings with Affinity CRM integration, attachment surfacing, and file delivery to Slack DM.

## Branch & Worktree

- **Branch:** `claude/beautiful-herschel`
- **Worktree:** `/Users/kyletaylor/Documents/Code Projects/nanoclaw/.claude/worktrees/beautiful-herschel`
- **Commits on branch:**
  - `897a2fd` — Main implementation (29 files): MCP split, Affinity, attachments, IPC file support
  - `1e36bea` — Simplify fixes (5 files)
  - `6446ff7` — TS2322 fix for container build

## Uncommitted Changes

### On worktree (`claude/beautiful-herschel`) — 5 files:
- `container/mcp-servers/affinity/src/index.ts` — **Major fixes:**
  - Switched `search_affinity_companies` from v2 `/companies` (broken, ignores `term`) to v1 `/organizations` with Basic auth (works)
  - Fixed `listId` vs `list_id` camelCase bug in `get_deal_log_entry`
  - Rewrote field parsing: v2 returns `{id, name, value: {type, data}}` not `{field_id, value}`. Removed stale FIELD_MAP, now uses API's human-readable field names
  - Eliminated redundant second API call — first call already returns fields
- `docs/plans/2026-04-14-001-feat-new-deal-briefings-mcp-split-plan.md` — status: completed
- `src/channels/slack.ts` — unused import (these are mirrored from main changes)
- `src/index.ts` — unused sendFile wiring (mirrored from main)
- `src/ipc.ts` — unused file handler (mirrored from main)

### On main — 5 files (host-side changes applied directly for testing):
- `src/container-runner.ts` — Added `api.affinity.co` to NO_PROXY env vars
- `src/types.ts` — Added `sendFile?` to Channel interface
- `src/channels/slack.ts` — Added `sendFile` method (uses `filesUploadV2`)
- `src/ipc.ts` — Added `sendFile` to IpcDeps, added `type: "file"` IPC handler with container→host path translation (`/workspace/ipc/` → host IPC dir)
- `src/index.ts` — Wired `sendFile` lambda in IPC deps

### On disk (gitignored, live):
- `groups/slack_main/CLAUDE.md` — Updated with:
  - Deck identification criteria (6 priority-ordered signals for picking pitch deck from multiple attachments)
  - Diagnostic footer (MCP status per server — ✅/❌ with error details)
  - Affinity search + Deal Log instructions

## Bugs Found & Fixed This Session

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| Container build TS2322 | Lowercarbon IIFE returned `{}` without type annotation | Added return type annotation |
| MCP servers offline | Session agent-runner-src cached old code, container reused stale session | Updated session files + cleared session DB |
| Affinity search returns wrong results | v2 `/companies?term=X` silently ignores `term` param | Switched to v1 `/organizations` with Basic auth |
| Deal Log entry not found | v2 uses `listId` (camelCase), code checked `list_id` (snake_case) | Fixed property name |
| Deal Log fields empty | v2 returns `{id, name, value: {type, data}}`, code expected `{field_id, value}` | Rewrote field parser, removed FIELD_MAP |
| File not delivered to Slack | IPC filePath was container path (`/workspace/ipc/files/...`), host tried to read literally | Added path translation in host IPC handler |

## Container Session Cache Pattern (IMPORTANT)

The host mounts `data/sessions/slack_main/agent-runner-src/` over `/app/src` inside the container. The container recompiles TypeScript at startup from this mounted source. **Changes to the container image's baked-in agent-runner are overridden by session files.** After rebuilding the container image, you must ALSO update:

```
data/sessions/slack_main/agent-runner-src/index.ts
data/sessions/slack_main/agent-runner-src/ipc-mcp-stdio.ts
```

Copy from the worktree:
```bash
cp container/agent-runner/src/index.ts /path/to/nanoclaw/data/sessions/slack_main/agent-runner-src/index.ts
cp container/agent-runner/src/ipc-mcp-stdio.ts /path/to/nanoclaw/data/sessions/slack_main/agent-runner-src/ipc-mcp-stdio.ts
```

Also clear the session to avoid resuming stale Claude context:
```bash
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder='slack_main';"
docker ps --format "{{.Names}}" | grep nanoclaw | xargs -r docker stop
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Testing Workflow

1. Rebuild container: `./container/build.sh` (from worktree)
2. Update session agent-runner-src files (see above)
3. Clear session + stop containers + restart host (see above)
4. Message bot in Slack — it spawns a fresh container

## What Still Needs Testing

- **Affinity Deal Log fields** — just fixed, untested. Should now return field data (stage, team, source, etc.) for companies on the Deal Log.
- **File delivery to Slack** — path translation fixed, untested. The `send_file` flow: agent downloads attachment → base64 → IPC file → host reads → Slack `filesUploadV2`.
- **Gmail connectivity** — last test showed email context missing. Unclear if this was a transient issue or a real bug. The diagnostic footer should reveal the status.
- **Granola** — token was refreshed via `npx tsx scripts/granola-auth.ts --token groups/slack_main/reference/granola-token.json`. Should work now.

## What Needs Doing Before Merge

1. **Commit the worktree changes** (Affinity fixes are uncommitted)
2. **Merge host-side changes** from main into the branch (or cherry-pick the worktree changes onto main)
3. **Remove diagnostic footer** from CLAUDE.md once testing is stable
4. **Verify Slack bot token scopes** include `files:read` and `files:write` (needed for attachment surfacing)
5. **End-to-end test** a NEW_DEAL briefing that exercises: Affinity search → Deal Log lookup → Gmail threads → Slack #dealflow → attachment download + delivery → Granola past meetings

## Key File Locations

| File | Purpose |
|------|---------|
| `container/mcp-servers/affinity/src/index.ts` | Affinity MCP (v1 search + v2 entries/notes) |
| `container/mcp-servers/google/src/index.ts` | Calendar + Gmail + download_attachment |
| `container/mcp-servers/slack/src/index.ts` | Slack search + download_slack_file |
| `container/mcp-servers/granola/src/index.ts` | Granola meeting notes proxy |
| `container/mcp-servers/lowercarbon/src/index.ts` | LC MCP portfolio proxy |
| `container/agent-runner/src/index.ts` | Agent runner (5 MCP server registration) |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | IPC MCP (send_message, send_file) |
| `groups/slack_main/CLAUDE.md` | System prompt (gitignored, live on disk) |
| `src/ipc.ts` | Host IPC handler (file path translation) |
| `src/channels/slack.ts` | Slack sendFile method |

## Affinity API Gotchas

- **v2 `/companies` does NOT support text search** — `term` param is silently ignored, returns all companies by ID
- **v1 `/organizations?term=X`** works — uses Basic auth (empty username, API key as password)
- **v2 uses camelCase** (`listId`, `createdAt`) not snake_case (`list_id`, `created_at`)
- **v2 field values** are `{type: string, data: actual_value}` not raw values
- **v2 company list-entries** includes fields inline — no second API call needed
- The affinity-bot repo (`github.com/Lowercarbon/affinity-bot`) uses the same v1 approach in `affinity_client.py`
