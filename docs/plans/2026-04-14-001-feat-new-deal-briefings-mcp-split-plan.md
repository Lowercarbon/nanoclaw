---
title: "feat: New Deal Briefings + MCP Server Split"
type: feat
status: completed
date: 2026-04-14
origin: docs/superpowers/specs/2026-04-14-new-deal-briefings-design.md
---

# feat: New Deal Briefings + MCP Server Split

## Overview

Split the monolith MCP server into 5 focused servers and add Affinity CRM integration to enable stage-aware NEW_DEAL meeting briefings. Two coupled changes: the architecture cleanup enables the new capability.

## Problem Statement / Motivation

The meeting prep agent can brief PORTFOLIO meetings well but has no data source for NEW_DEAL meetings. The system prompt references Affinity tools that don't exist yet. The monolith MCP server (`google-calendar-gmail/`) has grown to 1,264 lines containing 5 unrelated services, making it hard to maintain and misnamed.

## Proposed Solution

1. Split `container/mcp-servers/google-calendar-gmail/` into 5 independent MCP servers
2. Build a new Affinity MCP server that calls the Affinity REST API v2 directly
3. Update the agent-runner to register all 5 servers with proper credential injection
4. Update CLAUDE.md with stage-aware NEW_DEAL context gathering and corrected Granola behavior

(see origin: `docs/superpowers/specs/2026-04-14-new-deal-briefings-design.md`)

## Technical Approach

### Architecture

```
container/mcp-servers/
├── google/          # Calendar + Gmail (googleapis dep)
├── slack/           # Channel search + message search (fetch)
├── lowercarbon/     # Portfolio docs, company/portfolio facts (fetch, JSON-RPC proxy)
├── granola/         # Meeting note query/list/details (fetch, SSE parsing)
└── affinity/        # Company search, deal log entry, notes (fetch, REST API v2)
```

Each server: `McpServer` + `StdioServerTransport` + `zod` schemas. Single `src/index.ts`. Independent `package.json`. Conditionally registered in agent-runner based on credential file existence.

### Implementation Phases

#### Phase 1: MCP Server Split (foundation)

Extract each service from the monolith into its own server. No behavior changes — same tools, same APIs, same auth. The monolith directory is deleted after extraction.

**Tasks:**

- [ ] Create `container/mcp-servers/google/` — extract Calendar + Gmail tools, `initAuth()`, `stripHtml()`, `formatEvent()`, `extractBody()`, `extractAttachments()`, `getHeader()`, `gmailThreadUrl()`, `decodeBase64Url()`. Deps: `@modelcontextprotocol/sdk`, `zod`, `googleapis`. Env: `GOOGLE_CREDENTIALS_PATH`, `GOOGLE_TOKEN_PATH`.
  - `container/mcp-servers/google/package.json`
  - `container/mcp-servers/google/tsconfig.json`
  - `container/mcp-servers/google/src/index.ts`

- [ ] Create `container/mcp-servers/slack/` — extract `search_slack_channel` + `search_slack_messages` tools. Deps: `@modelcontextprotocol/sdk`, `zod`. Env: `SLACK_BOT_TOKEN`. Uses Node.js `fetch`.
  - `container/mcp-servers/slack/package.json`
  - `container/mcp-servers/slack/tsconfig.json`
  - `container/mcp-servers/slack/src/index.ts`

- [ ] Create `container/mcp-servers/lowercarbon/` — extract `portfolio_documents`, `get_company_facts`, `get_portfolio_facts` tools + `callLcMcpTool()` helper. Deps: `@modelcontextprotocol/sdk`, `zod`. Env: `LC_MCP_URL`, `LC_MCP_API_KEY`. Uses Node.js `fetch` (JSON-RPC over HTTP).
  - `container/mcp-servers/lowercarbon/package.json`
  - `container/mcp-servers/lowercarbon/tsconfig.json`
  - `container/mcp-servers/lowercarbon/src/index.ts`

- [ ] Create `container/mcp-servers/granola/` — extract `query_granola_meetings`, `list_granola_meetings`, `get_granola_meeting` tools + `callGranolaTool()` helper + SSE response parsing. Deps: `@modelcontextprotocol/sdk`, `zod`. Env: `GRANOLA_TOKEN_PATH`. **Preserve the SSE fix from commit 2b8bbcf** (skip progress notifications).
  - `container/mcp-servers/granola/package.json`
  - `container/mcp-servers/granola/tsconfig.json`
  - `container/mcp-servers/granola/src/index.ts`

- [ ] Delete `container/mcp-servers/google-calendar-gmail/` after all extractions verified.

**Success criteria:** Each server starts independently, tools work in isolation, no shared state between servers.

#### Phase 2: Container wiring

Update Dockerfile, agent-runner, and container-runner to support all 5 servers.

**Tasks:**

- [ ] Update `container/Dockerfile` — replace single MCP server build block with 5 sequential COPY+install+build blocks. Package.json first (layer cache), then source, then `npx tsc`. Delete the old `google-calendar-gmail` references.
  - `container/Dockerfile`

- [ ] Update `container/agent-runner/src/index.ts` — split the single `google` mcpServers entry into 5 conditional entries:
  - `google` — if `google-credentials.json` AND `google-token.json` exist. Env: file paths.
  - `slack` — if `slack-bot-token.txt` exists and is non-empty. Env: token value read via IIFE.
  - `lowercarbon` — if `.mcp.json` has `lowercarbon-mcp` config. Env: URL + API key extracted via IIFEs (same pattern as today).
  - `granola` — if `granola-token.json` exists. Env: file path.
  - `affinity` — if `reference/affinity-api-key.txt` exists. Env: API key value read via IIFE.
  - Update `allowedTools`: replace `'mcp__lowercarbon-mcp__*'` with `'mcp__lowercarbon__*'`, add `'mcp__slack__*'`, `'mcp__granola__*'`, `'mcp__affinity__*'`.
  - `container/agent-runner/src/index.ts`

- [ ] Update `src/container-runner.ts` — add `api.affinity.co` to `NO_PROXY` and `no_proxy` env vars so Affinity API calls bypass OneCLI proxy.
  - `src/container-runner.ts`

- [ ] Rebuild container: `docker builder prune -f && ./container/build.sh` (prune required due to buildkit cache gotcha).

**Success criteria:** Container builds successfully. All 5 servers register when credentials are present. Existing PORTFOLIO briefings still work (regression check).

#### Phase 3: Affinity MCP Server (new capability)

Build the new Affinity server that calls the REST API v2 directly.

**Tasks:**

- [ ] Create `container/mcp-servers/affinity/` with 3 tools:
  - `search_affinity_companies` — `GET https://api.affinity.co/v2/companies?term={query}`. Returns company ID, name, domain.
  - `get_deal_log_entry` — two sequential calls: `GET /v2/companies/{id}/list-entries` (filter for list 205572), then `GET /v2/lists/205572/list-entries/{entry_id}` with all field types. Maps field IDs to readable names (field ID mapping from spec Section 2). Returns null if not on Deal Log.
  - `get_affinity_notes` — `GET /v2/companies/{id}/notes`. Returns up to 10 notes newest first, with creator name and date. Strip HTML from note content.
  - Auth: `Authorization: Bearer {AFFINITY_API_KEY}` header.
  - Error handling: retry once on 429, return error text to agent on other failures.
  - `stripHtml()` helper: copy from google server (needed for note content).
  - `container/mcp-servers/affinity/package.json`
  - `container/mcp-servers/affinity/tsconfig.json`
  - `container/mcp-servers/affinity/src/index.ts`

- [ ] Create `groups/slack_main/reference/affinity-api-key.txt` with the Affinity API key from Kyle's account.

**Success criteria:** Agent can call `search_affinity_companies("Charm Industrial")`, get a company ID, call `get_deal_log_entry` and receive structured deal fields, call `get_affinity_notes` and receive internal notes.

#### Phase 4: Attachment Surfacing

Add the ability to download Gmail attachments and push them to the user's Slack DM alongside briefings.

**Tasks:**

- [ ] Add `download_attachment` tool to `container/mcp-servers/google/src/index.ts`:
  - Params: `message_id` (string), `attachment_id` (string)
  - Calls `GET /gmail/v1/users/me/messages/{messageId}/attachments/{attachmentId}`
  - Returns: base64 file content, filename, mime type
  - The message_id and attachment_id are available from existing `get_thread` results (which already surface attachment filenames + IDs)
  - `container/mcp-servers/google/src/index.ts`

- [ ] Add `send_file` tool to `container/agent-runner/src/ipc-mcp-stdio.ts`:
  - Params: `file_content_base64` (string), `filename` (string)
  - Writes decoded file to `/workspace/ipc/files/{timestamp}-{filename}`
  - Writes IPC message JSON to `/workspace/ipc/messages/` with `type: "file"`, `chatJid`, `filePath`, `filename`
  - `container/agent-runner/src/ipc-mcp-stdio.ts`

- [ ] Add `sendFile` to Channel interface in `src/types.ts`:
  - `sendFile(jid: string, filePath: string, filename: string): Promise<void>`
  - `src/types.ts`

- [ ] Implement `sendFile` in the Slack channel:
  - Uses Slack `files.uploadV2` API with the bot token
  - Verify bot token has `files:write` scope (may need to update the Slack app)
  - Find the Slack channel implementation file and add the method

- [ ] Update `src/ipc.ts` to handle `type: "file"` IPC messages:
  - Read the file from the path specified in the IPC message
  - Call `channel.sendFile(jid, filePath, filename)` via the router
  - Clean up the temp file after successful upload
  - `src/ipc.ts`

- [ ] Update `src/router.ts` to add a `sendFile` function alongside `sendMessage`:
  - `src/router.ts`

- [ ] Add `mcp__nanoclaw__send_file` to `allowedTools` in agent-runner (or verify `mcp__nanoclaw__*` wildcard already covers it).

**Success criteria:** Agent can find a PDF attachment in a Gmail thread, download it, and push it to the user's Slack DM. The file appears in Slack as a downloadable attachment.

#### Phase 5: CLAUDE.md Prompt Updates

Update the system prompt with stage-aware NEW_DEAL behavior and corrections.

**Tasks:**

- [ ] Update **Meeting Classification — NEW_DEAL** section:
  - Replace step 1 with concrete Affinity tool calls: `search_affinity_companies` → `get_deal_log_entry`
  - Remove step 3 (LC MCP portfolio confirmation)
  - Add attendee-to-company inference guidance: identify the one company the meeting is about. Strip email domain, skip personal domains (gmail/yahoo/outlook/icloud/hotmail), fall back to meeting title. If multiple external companies, pick the deal company (not the intro source/co-investor/advisor). One Affinity lookup per meeting.

- [ ] Replace **Context Gathering — NEW_DEAL** section with stage-aware tiers:
  - Step 0: Affinity lookup (determines tier weights)
  - Tier 1: Affinity deal context (skip if not in Deal Log)
  - Tier 2: Affinity notes (skip if company not in Affinity)
  - Tier 3: Email threads (always, primary if not in Deal Log)
  - Tier 4: Slack #dealflow (always)
  - Tier 5: Granola past meetings per external attendee (always)
  - Tier 6: Web search — person names always, company name only Series B+
  - Remove Tier 4 "Portfolio overlap (LC MCP)"

- [ ] Update **Output Format — NEW_DEAL** section:
  - Add *Deal context* section (deal stage, team, source; pass reason if applicable)
  - Drop *Portfolio overlap* section

- [ ] Update **Granola guidance in ALL meeting types** (PORTFOLIO, LP, OTHER, UNKNOWN):
  - Change from "search for past meetings with the same attendees" to "search for prior meetings with each external attendee individually"

- [ ] Add **Attachment surfacing** guidance:
  - NEW_DEAL: attach the most recent pitch/fundraising deck from the intro email thread using `download_attachment` + `send_file`
  - PORTFOLIO board meetings: attach the pre-read or board deck if found in the meeting thread
  - After attaching a deck, offer: "I've attached the deck from the intro email. Want me to summarize it or suggest key questions for the founder?"
  - Do not attach files for other meeting types unless specifically relevant

- [ ] Update **Reference Data** section:
  - Add Affinity Deal Log (list 205572) with tool names
  - Note that Affinity tools are available via `mcp__affinity__*`

- [ ] Update `docs/meeting-prep-agent.md`:
  - Move Affinity from "Phase 2 Integrations (deferred)" to active integrations
  - Add Affinity credential setup instructions
  - Update meeting classification table

All CLAUDE.md changes to: `groups/slack_main/CLAUDE.md`
Documentation changes to: `docs/meeting-prep-agent.md`

**Success criteria:** Agent correctly classifies NEW_DEAL meetings, calls Affinity tools, applies stage-aware tier weights, and produces briefings with deal context when available.

## Acceptance Criteria

### Functional Requirements

- [ ] All 5 MCP servers build and start independently in the container
- [ ] Existing PORTFOLIO briefings work identically (no regression)
- [ ] NEW_DEAL meetings get Affinity context when company is in Deal Log
- [ ] NEW_DEAL meetings for unknown companies fall back to email + external context
- [ ] Previously passed deals surface pass reason prominently
- [ ] Granola searches per external attendee (all meeting types)
- [ ] Web search: person names at all stages, company name only Series B+
- [ ] Agent does NOT call LC MCP for NEW_DEAL meetings

### Non-Functional Requirements

- [ ] Container image builds in under 5 minutes
- [ ] Each MCP server starts in under 2 seconds
- [ ] Affinity API calls complete in under 5 seconds each

## Dependencies & Risks

- **Affinity API key** — Kyle has one (created 2026-03-17). Needs to be saved to `reference/affinity-api-key.txt`.
- **Affinity field IDs** — Hardcoded to LC's Deal Log. If fields are renamed/recreated, IDs change. Low risk (stable within account).
- **BuildKit cache** — Must prune builder before first rebuild after split. Known gotcha documented in CLAUDE.md.
- **`NO_PROXY` update** — `api.affinity.co` must be added to bypass OneCLI proxy. Missing this causes silent auth failures.

## Sources & References

### Origin

- **Origin document:** [docs/superpowers/specs/2026-04-14-new-deal-briefings-design.md](docs/superpowers/specs/2026-04-14-new-deal-briefings-design.md) — Key decisions: direct REST API calls (not Python MCP bridge), hardcoded Deal Log list ID 205572, stage-aware tier weights, drop LC MCP for NEW_DEAL, Granola per-attendee correction.

### Internal References

- Monolith MCP server: `container/mcp-servers/google-calendar-gmail/src/index.ts`
- Agent runner mcpServers config: `container/agent-runner/src/index.ts:479-534`
- Container runner NO_PROXY: `src/container-runner.ts:275`
- System prompt: `groups/slack_main/CLAUDE.md`
- Setup docs: `docs/meeting-prep-agent.md`

### External References

- Affinity API v2 docs: https://developer.affinity.co/pages/external-api-v2
- Affinity MCP setup (local stdio): https://developer.affinity.co/pages/mcp/setup
