# New Deal Meeting Briefings — Design Spec

## Goal

Enable the meeting prep agent to deliver contextual briefings for NEW_DEAL meetings by integrating Affinity as a data source and restructuring the container MCP architecture.

## Two changes in one branch

1. **MCP server split** — Break the monolith `google-calendar-gmail` MCP server into 5 focused servers.
2. **New Deal briefings** — Add Affinity tools, update NEW_DEAL classification and context gathering, refine the system prompt.

---

## 1. MCP Server Architecture

### Current state

A single MCP server (`container/mcp-servers/google-calendar-gmail/`) containing:
- Google Calendar tools
- Gmail tools
- Slack tools
- Lowercarbon MCP proxy tools
- Granola tools

Registered as one server named `google` in the agent-runner `query()` call.

### New state

Five independent MCP servers, each focused on one service:

| Server name | Directory | Tools | Auth env vars |
|---|---|---|---|
| `google` | `mcp-servers/google/` | `list_calendars`, `list_events`, `get_event`, `search_threads`, `get_thread`, `list_messages` | `GOOGLE_CREDENTIALS_PATH`, `GOOGLE_TOKEN_PATH` |
| `slack` | `mcp-servers/slack/` | `search_slack_channel`, `search_slack_messages` | `SLACK_BOT_TOKEN` |
| `lowercarbon` | `mcp-servers/lowercarbon/` | `portfolio_documents`, `get_company_facts`, `get_portfolio_facts` | `LC_MCP_URL`, `LC_MCP_API_KEY` |
| `granola` | `mcp-servers/granola/` | `query_granola_meetings`, `list_granola_meetings`, `get_granola_meeting` | `GRANOLA_TOKEN_PATH` |
| `affinity` | `mcp-servers/affinity/` | `search_affinity_companies`, `get_deal_log_entry`, `get_affinity_notes` | `AFFINITY_API_KEY` |

### Shared patterns

Each server follows the same structure:
- `package.json` with `@modelcontextprotocol/sdk` and `zod` as dependencies (plus service-specific deps)
- `src/index.ts` — single file, registers tools on an `McpServer`, uses `StdioServerTransport`
- `tsconfig.json` — standard config targeting ES2022/NodeNext
- Conditionally enabled in agent-runner based on whether credentials exist
- No shared package — servers are independent. Copy the boilerplate.

### Dockerfile changes

Replace the single MCP server build block with 5:

```dockerfile
# Build each MCP server
COPY mcp-servers/google/package*.json /app/mcp-servers/google/
RUN cd /app/mcp-servers/google && npm install
COPY mcp-servers/google/ /app/mcp-servers/google/
RUN cd /app/mcp-servers/google && npx tsc

# Repeat for slack, lowercarbon, granola, affinity
```

### agent-runner changes

Update `mcpServers` in the `query()` call. Each server is conditionally registered:

- `google` — if `google-token.json` exists
- `slack` — if `slack-bot-token.txt` exists and is non-empty
- `lowercarbon` — if `.mcp.json` contains `lowercarbon-mcp` config
- `granola` — if `granola-token.json` exists
- `affinity` — if `reference/affinity-api-key.txt` exists

Update `allowedTools` — replace `mcp__lowercarbon-mcp__*` with `mcp__lowercarbon__*` (rename from hyphenated `.mcp.json` key to clean server name):
```
'mcp__google__*'
'mcp__slack__*'
'mcp__lowercarbon__*'
'mcp__granola__*'
'mcp__affinity__*'
```

### Credential injection per server

Each server gets its credentials via env vars injected by agent-runner (same IIFE pattern as today):

| Server | Credential source | Env vars passed |
|---|---|---|
| `google` | `reference/google-credentials.json`, `reference/google-token.json` | `GOOGLE_CREDENTIALS_PATH`, `GOOGLE_TOKEN_PATH` (file paths) |
| `slack` | `reference/slack-bot-token.txt` | `SLACK_BOT_TOKEN` (value read from file) |
| `lowercarbon` | `.mcp.json` → `mcpServers['lowercarbon-mcp']` | `LC_MCP_URL` (extracted URL), `LC_MCP_API_KEY` (extracted Bearer token) |
| `granola` | `reference/granola-token.json` | `GRANOLA_TOKEN_PATH` (file path; server reads the token from disk, refreshes via `refresh_token` when needed, and persists refreshed tokens back to the group token file) |
| `affinity` | `reference/affinity-api-key.txt` | `AFFINITY_API_KEY` (value read from file) |

---

## 2. Affinity MCP Server

### Transport

Direct HTTP calls to the Affinity REST API v2 (`https://api.affinity.co/v2/`). Auth via `Authorization: Bearer {AFFINITY_API_KEY}` header. No dependency on the Python `affinity-mcp` package.

### Tools

#### `search_affinity_companies`

Search Affinity for a company by name or domain.

- **API call:** `GET /v2/companies?term={query}`
- **Params:** `query` (string, required)
- **Returns:** Company ID, name, domain, interaction dates (first/last email, first/last event)
- **Purpose:** Entry point for Affinity lookup. If no match, company is not tracked.

#### `get_deal_log_entry`

Check if a company is on the Deal Log and pull deal fields.

- **API calls:**
  1. `GET /v2/companies/{company_id}/list-entries` — find the list entry on Deal Log (list ID 205572)
  2. `GET /v2/lists/205572/list-entries/{entry_id}` with all field types — pull field values
- **Params:** `company_id` (string, required)
- **Returns:** If on Deal Log: Deal Stage, Deal Team, Deal Notes, Pass Reason, Pass Details, Investment Round, Raise Size, Pre-Money Valuation, Deal Source (person/org/channel), Gut Check, Follow On, Proprietary. If not on Deal Log: null.
- **Field ID mapping:** The tool maps Affinity field IDs to readable names internally. Key fields:
  - `field-3832132` → Deal Stage (ranked-dropdown)
  - `field-5092585` → Deal Team (person-multi)
  - `field-3860236` → Deal Notes (text)
  - `field-3832139` → Pass Reason (dropdown-multi)
  - `field-4741256` → Pass Details (text)
  - `field-3832137` → Investment Round (dropdown)
  - `field-4831812` → Raise Size (number)
  - `field-4831811` → Pre-Money Valuation (number)
  - `field-3832140` → Deal Source: Person (person-multi)
  - `field-3832141` → Deal Source: Org (company-multi)
  - `field-3832135` → Deal Source: Channel (dropdown-multi)
  - `field-4144018` → Gut Check (dropdown)
  - `field-4163630` → Follow On (dropdown)
  - `field-3857151` → Proprietary (dropdown)
  - `field-3836800` → Deal Start Date (datetime)
  - `field-3836801` → Deal Close Date (datetime)

#### `get_affinity_notes`

Pull internal notes attached to a company.

- **API call:** `GET /v2/companies/{company_id}/notes`
- **Params:** `company_id` (string, required)
- **Returns:** Up to 10 notes, newest first. Each note: HTML content (stripped to text), creator name, date, type (manual vs interaction-tagged).

### Dependencies

- `@modelcontextprotocol/sdk` — MCP server framework
- `zod` — input validation
- No additional dependencies. Uses Node.js built-in `fetch` for HTTP calls.

### Credential storage

`reference/affinity-api-key.txt` — plain text file containing the API key, same pattern as `slack-bot-token.txt`. Read by agent-runner at container startup and injected as `AFFINITY_API_KEY` env var.

### Error handling

- HTTP errors: return error text to agent (e.g., "Affinity API error: 404 Not Found"). Agent decides whether to skip Affinity and rely on other sources.
- Rate limits (HTTP 429): retry once after 2 seconds, then return error. Agent proceeds with other tiers.
- Empty results: `search_affinity_companies` returning no matches is not an error — it means the company isn't tracked. Return a clear "no results" message.

---

## 3. NEW_DEAL Classification Update

### Current detection (CLAUDE.md)

1. Search the Affinity Deal Log list for the company name
2. Infer from email threads
3. The company is NOT in the LC MCP portfolio (confirmed by search)

### Updated detection

1. Search Affinity: `search_affinity_companies` with company name inferred from attendee domain/meeting title
2. If found, check Deal Log: `get_deal_log_entry` with the company ID
3. Infer from email threads — intro chains, pitch deck language, "first meeting" language
4. **Removed:** LC MCP portfolio confirmation. NEW_DEAL classification must NOT call Lowercarbon MCP. The LC MCP only contains portfolio company data.

Not every external meeting is a new deal. Meetings with VCs, banks, law firms, corporates, service providers are classified as OTHER unless context suggests a fundraising pitch.

### Attendee-to-company inference

The agent infers the one company the meeting is about from calendar attendees. CLAUDE.md should include guidance:
- Extract domain from attendee email (e.g., `jane@dioxycle.com` → search "Dioxycle")
- Skip personal email domains (gmail.com, yahoo.com, outlook.com, icloud.com, hotmail.com) — fall back to meeting title or email thread analysis
- If multiple external attendees are from different companies, identify the one company the meeting is about. The others are likely intro sources, co-investors, or advisors — ignore them. Prioritize: (a) company named in meeting title, (b) the company domain that is NOT a known VC/bank/law firm.
- Only one Affinity lookup per meeting — the deal company, not every attendee's org.
- This is a heuristic — the agent may not always resolve correctly. The existing "ask for confirmation when uncertain" principle applies.

---

## 4. NEW_DEAL Context Gathering — Stage-Aware Tiers

### Step 0: Affinity lookup (always runs first)

`search_affinity_companies` → `get_deal_log_entry`

Determines the company's pipeline status and which tier weights to use:

| Affinity Result | Behavior |
|---|---|
| **Not in Deal Log** | Max external context. Heavy on email (intro chains), web search (founder bios), #dealflow. Affinity notes if the company exists in Affinity at all. |
| **Early stage** (Triage, Initial Screen, Pre-Deal) | Mix of external + internal. Affinity deal notes + deal source, email threads, #dealflow, plus external founder/company context. |
| **Deep stage** (DD, IC, Term Sheet, Closing) | Heavy internal signal. Affinity deal notes, deal team, email threads, #dealflow, Granola past meetings. Light external (person news only). |
| **Pass stage** (Pass - Immediate, Pass - Initial Screen, Pass - DD, Pass - IC, Pass - TS, Passed [legacy], Lost - Pre-IC, Lost - Post-IC, Did Not Pursue) | Surface pass reason + pass details prominently at the top. Then treat like early stage — re-engagement means the team needs to re-familiarize. |

### Tier 1: Affinity deal context

- Deal stage, deal team, deal source (person/org/channel), deal notes
- If pass stage: pass reason and pass details surfaced prominently
- Investment round, raise size, pre-money valuation if populated
- **Skip if not in Deal Log.**

### Tier 2: Affinity notes

- Internal notes attached to the company in Affinity
- Creator name and date for each note
- **Skip if company not found in Affinity at all.**

### Tier 3: Email threads (Gmail)

- Intro email chains — who made the intro and what they said
- Internal LC email discussion — forwards between partners, reactions
- Attached decks or materials (note filenames)
- Filter out calendar invite emails
- **Always runs. Primary source if not in Deal Log.**

### Tier 4: Team discussion (Slack #dealflow)

- Search #dealflow for the company name
- Who posted it, partner reactions, concerns raised
- **Always runs.**

### Tier 5: Past meeting notes (Granola)

- Search for prior meetings with each external attendee individually (not as a group)
- Surface key points from the most recent meeting per person
- **Always runs.**

### Tier 6: External context (web search)

Weight varies by deal stage and investment round:

| Search target | When to search |
|---|---|
| **Person/founder names** | Always, at every stage. Background, prior companies, relevant news. Only when confident it's the right person (disambiguate common names). |
| **Company name** | Series B+ only. Early-stage companies (Seed, Series A) have little useful web presence. Use the Investment Round field from Deal Log to determine this. If round is unknown, default to person-only search. |

---

## 5. Granola Correction — All Meeting Types

Granola searches should key off each external attendee individually across all meeting types (PORTFOLIO, NEW_DEAL, LP, OTHER, UNKNOWN). Search "find past meetings with [person name]" per person, not "find past meetings with all these attendees together." This surfaces separate 1:1s and prior meetings that didn't include all the same people.

This is a CLAUDE.md prompt change that applies to all context gathering sections, not just NEW_DEAL.

---

## 6. Attachment Surfacing

The agent can already see attachment filenames in Gmail threads. This adds the ability to download the actual file and push it to the user's Slack DM alongside the briefing.

### New capabilities

**Gmail tool: `download_attachment`**
- Given a message ID and attachment ID (both available from `get_thread` results), downloads the file content via `GET /gmail/v1/users/me/messages/{messageId}/attachments/{attachmentId}`
- Returns: base64 file content, filename, mime type

**NanoClaw IPC: `send_file` message type**
- New IPC message type alongside existing `message` type
- Container writes file bytes to `/workspace/ipc/files/`, IPC message references the file path
- Host-side IPC processor reads the file path and calls `channel.sendFile()`

**Channel interface: `sendFile(jid, filePath, filename)`**
- New method on the `Channel` interface
- Slack implementation: uses `files.uploadV2` API (requires `files:write` scope on bot token)

**Container MCP tool: `send_file`**
- On the `nanoclaw` IPC MCP server
- Agent calls `send_file(file_content_base64, filename)` to push a file to the user's DM

### File sources

Files can come from **two sources**:

**Gmail attachments:**
- `download_attachment` tool fetches file bytes from Gmail API
- Agent identifies relevant attachments from `get_thread` results (which include message IDs and attachment IDs)

**Slack file uploads:**
- Files are frequently uploaded directly to Slack channels (#dealflow for new deals, portfolio company channels for board materials)
- `search_slack_messages` must be enhanced to return file metadata when messages have attachments (file ID, name, mimetype, url_private_download)
- New tool `download_slack_file`: fetches file content via Slack's `url_private_download` URL with bot token auth
- Requires `files:read` scope on the bot token (in addition to `files:write` for uploading)

### When to attach files

| Meeting type | Where to look | What to attach |
|---|---|---|
| **NEW_DEAL** | Gmail intro thread + Slack #dealflow | Most recent pitch deck / fundraising deck |
| **PORTFOLIO** (board meeting) | Gmail meeting thread + portfolio Slack channel | Pre-read or board deck if provided |
| **Other** | — | No automatic attachment |

### Follow-up interaction

After delivering the briefing with an attached deck, offer:
> "I've attached the deck from the intro email. Want me to summarize it or suggest key questions for the founder?"

This enables a natural follow-up conversation where the agent analyzes the deck content.

---

## 7. NEW_DEAL Output Format Update

Current format has: *Why now*, *Key context*, *Internal signal*, *Portfolio overlap*, *Past meeting notes*.

Updated format:

- *Deal context* (only if in Deal Log) — Deal stage, deal team, deal source. If previously passed: pass reason flagged prominently (e.g., ":warning: LC previously passed at DD — [reason]").
- *Why now* — Who made the intro, what triggered this meeting.
- *Key context* — Founder backgrounds (full first and last names), what the company does, funding history. Weight varies by stage.
- *Internal signal* — Affinity notes, #dealflow discussion, internal email threads.
- *Past meeting notes* — Key points from prior Granola meetings with each external attendee.

**Dropped:** *Portfolio overlap* section — removed. LC MCP is not called for NEW_DEAL meetings.

---

## 8. What's NOT in scope

- Upgrading Slack `search_slack_messages` to use `search.messages` API for full channel history (currently uses `conversations.history` with client-side filter, limited to 50 most recent messages)
- iMessage / WhatsApp read-only integration (Phase 2 — requires Google Contacts People API for phone number resolution)
- StandardMetrics financial metrics
- Salesforce / Hanover Park LP data
- Sidney onboarding
- Two-phase cron schedule
- Tailscale web onboarding
