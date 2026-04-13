# LC Meeting Prep Agent — Technical Specification (NanoClaw)

**Version:** v0.3 (final draft)
**Date:** April 10, 2026
**Author:** Kyle Taylor / Claude
**Runtime:** NanoClaw on macOS (Intel MacBook Pro for testing → Mac Mini M4 for production)

---

## Overview

A NanoClaw-based agent that delivers contextual meeting briefings to Lowercarbon Capital team members via Slack DM, ~10 minutes before each calendar event. The agent pre-researches context from internal systems in priority order, confirms the meeting is still scheduled immediately before delivery, and remains available in the same Slack DM thread for follow-up questions.

**Why NanoClaw over OpenClaw:**
- OS-level container isolation (Docker/Apple Container) vs application-level allowlists
- ~700 lines of auditable TypeScript vs 430K+ lines with 255+ CVEs
- Claude-native (built on Anthropic Agent SDK) — no multi-model routing complexity
- Local stdio MCP servers (Affinity) work natively inside containers
- Minimal attack surface — no community skills, no ClawHub dependencies

**Design principles:**
- Read-only access to all data sources. The agent never sends emails, posts to channels, or writes to any system.
- Internal context first. Web search is a fallback, not the starting point.
- The output should read like a note from a sharp junior analyst who read all your recent correspondence and internal docs — not a Wikipedia summary.
- If there's nothing useful to add beyond the calendar invite, don't send a briefing. Silence = nothing to prep.

---

## Phase 1: MacBook Pro Setup (Testing)

### Prerequisites

- 2017 Intel MacBook Pro (any RAM config is fine — agents are API-bound, not compute-bound)
- macOS updated to latest supported version
- Docker Desktop installed (required for NanoClaw container isolation on Intel Macs)
- Claude Code installed and authenticated (`npm install -g @anthropic-ai/claude-code`)
- Node.js 22+ (via Homebrew: `brew install node@22`)
- Git
- Anthropic API key

### System prep

```bash
# Prevent sleep (critical for always-on agent)
sudo pmset -a sleep 0 disksleep 0 displaysleep 0
sudo pmset -a hibernatemode 0 powernap 0

# Enable SSH for remote access from your main machine
# System Settings > General > Sharing > Remote Login > On

# Install Docker Desktop from https://www.docker.com/products/docker-desktop/
# After install, verify:
docker --version
docker info | grep "Server Version"
```

### Install NanoClaw

```bash
# Clone the repo
git clone https://github.com/qwibitai/nanoclaw.git
cd nanoclaw

# Start Claude Code from inside the NanoClaw directory
# NanoClaw's setup is guided through Claude Code, not a traditional installer
claude

# Inside Claude Code, the guided setup will:
# 1. Verify prerequisites (Node, Docker, Claude Code auth)
# 2. Set up the container runtime
# 3. Configure your first agent
# 4. Connect messaging channels
```

### Configure Kyle's agent

After the base NanoClaw install, configure the first agent. NanoClaw uses
CLAUDE.md files and skills for customization rather than config files.

The agent needs the following MCP servers configured:

```json
{
  "mcpServers": {
    "google-calendar": {
      "url": "https://gcal.mcp.claude.com/mcp",
      "transport": "sse",
      "authorization_token": "<KYLE_OAUTH_TOKEN>"
    },
    "gmail": {
      "url": "https://gmail.mcp.claude.com/mcp",
      "transport": "sse",
      "authorization_token": "<KYLE_OAUTH_TOKEN>"
    },
    "lowercarbon-mcp": {
      "url": "https://vectorize-mcp-303642812800.us-central1.run.app",
      "transport": "sse",
      "authorization_token": "<LC_MCP_TOKEN>"
    },
    "standardmetrics": {
      "url": "https://mcp.standardmetrics.io/mcp",
      "transport": "sse",
      "authorization_token": "<SM_TOKEN>"
    },
    "slack": {
      "url": "https://mcp.slack.com/mcp",
      "transport": "sse",
      "authorization_token": "<SLACK_TOKEN>"
    },
    "granola": {
      "url": "https://mcp.granola.ai/mcp",
      "transport": "http",
      "authorization_token": "<GRANOLA_OAUTH_TOKEN>"
    },
    "affinity": {
      "command": "npx",
      "args": ["-y", "@affinity/mcp-server"],
      "env": {
        "AFFINITY_API_KEY": "<AFFINITY_API_KEY>"
      }
    }
  }
}
```

Note: Most servers are remote (SSE transport). Granola uses Streamable HTTP
transport with browser-based OAuth — each user authenticates individually
via a browser flow (no API key or service account). Requires paid Granola
plan for access to notes beyond 30 days. Affinity is local stdio — this is
one of the key reasons for NanoClaw over Managed Agents. When Affinity
ships their hosted MCP, this can be converted to a remote URL.

The Salesforce MCP is deferred to Phase 2. It only matters for LP meetings.

---

## Phase 2: Production Migration (Mac Mini)

When the prototype is working:

- Buy Mac Mini M4, 16GB, 512GB SSD (~$700)
- Same system prep (disable sleep, enable SSH, FileVault, Tailscale)
- Create a dedicated non-admin macOS user for NanoClaw
- Clone the working config from the MacBook Pro
- Install LuLu (free, Objective-See) for outbound network monitoring
- Set up launchd daemon for auto-start on boot
- Add UPS for power resilience

### Multi-agent setup for team rollout

Each team member gets an isolated agent directory:

```
~nanoclaw-user/
├── agents/
│   ├── kyle/
│   │   ├── CLAUDE.md          # Agent personality + instructions
│   │   ├── mcp-config.json    # Kyle's MCP servers (personal OAuth tokens)
│   │   └── memory/            # Persistent memory
│   ├── clay/
│   │   ├── CLAUDE.md
│   │   ├── mcp-config.json    # Clay's OAuth tokens
│   │   └── memory/
│   ├── ryan/
│   │   └── ...
│   └── shared/
│       ├── system-prompt.md   # Shared meeting prep instructions
│       ├── slack-allowlist.json
│       └── portfolio-channels.json
```

**Per-user resources (require individual auth):**
- Google Calendar OAuth token
- Gmail OAuth token
- Granola token (optional — user opts in)

**Shared resources (org-level tokens):**
- Lowercarbon MCP
- StandardMetrics
- Slack MCP
- Salesforce MCP (Phase 2)
- Affinity MCP (local stdio, shared API key)

### Onboarding a new team member

1. Create their agent directory
2. Copy shared system prompt + config templates
3. Ask them to authorize:
   - Google Calendar (required)
   - Gmail (recommended)
   - Granola (optional)
4. Set up their Slack DM channel ID
5. Add their cron schedule
6. Test with a single upcoming meeting before enabling full automation

---

## Agent System Prompt (CLAUDE.md)

This goes in each agent's CLAUDE.md or in the shared system-prompt.md
referenced by all agents.

```markdown
# Meeting Prep Agent — Lowercarbon Capital

You are a meeting prep agent for Lowercarbon Capital (LC), a climate-focused
venture capital firm. Your job is to prepare contextual briefings before
meetings so that the LC team member walks in fully prepared.

## Your constraints

- You have READ-ONLY access to all systems. You cannot send emails, post
  to Slack, modify calendar events, or write to any database.
- Your only output is the briefing text delivered to the user via Slack DM.
- If you cannot find meaningful context beyond what's already visible in
  the calendar invite, output "NO_BRIEFING_NEEDED" and nothing else.

## Meeting classification

Examine the calendar event and classify:

**PORTFOLIO** — Attendee is from a current LC portfolio company. Confirm by
checking if the company exists in the Lowercarbon MCP.

**NEW_DEAL** — Potential investment not yet in the portfolio. Title contains
"intro," "pitch," "first meeting," or the email thread is an introduction.

**LP** — Current or prospective limited partner. Check Salesforce for the
attendee if available.

**INTERNAL** — All attendees are @lowercarbon.com, @lowercarboncapital.com,
or @lowercasellc.com.

**UNKNOWN** — Cannot classify. Lightweight brief only.

## Context gathering — PORTFOLIO meetings

Gather in priority order. Stop or deprioritize lower tiers when higher
tiers give rich context.

### Tier 1: Email threads (Gmail)
Search for recent threads involving the meeting attendees. Focus on:
- Why this specific meeting was scheduled
- What was last discussed, any open action items
- Attachments (note filenames — decks, updates, memos)

### Tier 2: Curated internal knowledge (Lowercarbon MCP)
Query for the specific portfolio company by canonical name. Pull:
- Most recent investor update summary
- IC memos, deal notes, internal assessments

Company name rules:
- "Arc Boats" not "Arc"
- "Heart Aerospace" not "Heart"
- "SolarSquare" as one word
- Always canonicalize via Lowercarbon MCP before pulling documents

### Tier 3: Recent team discussion (Slack)
Search the portfolio company's Slack channel for messages from the
last 30 days. Channel names match the company name in the Lowercarbon
MCP (e.g., Dioxycle → #dioxycle, Arc Boats → #arc-boats).

Only search allowlisted channels. Do not search #general, #random,
or any non-portfolio channel besides #dealflow.

### Tier 4: Past meeting notes (Granola)
If Granola is connected, search for past meetings with the same
attendees. Surface: what was discussed last time, action items,
unresolved topics.

### Tier 5: Financial data (StandardMetrics)
Pull latest metrics: revenue, burn rate, runway, headcount, last
round details, LC ownership position.

### Tier 6: External context (web search)
ONLY if tiers 1-5 returned thin results. Recent press, funding
announcements, competitive moves since the last internal update.

NEVER lead with web search results for a portfolio company. If you
have rich internal context, skip this tier entirely.

## Context gathering — NEW_DEAL meetings

### Tier 1: Email threads (Gmail)
The intro email chain. Who made the intro and what they said. Internal
LC email discussion — forwards between partners, reactions. Attached
decks or materials.

### Tier 2: Affinity notes
Query Affinity for the company name. Pull all team notes, tags, list
status, linked attachments. This captures initial impressions and
prior touch points.

### Tier 3: Team discussion (Slack #dealflow)
Search #dealflow for the company name. Who posted it, partner
reactions, concerns raised, comparisons to existing portfolio.

### Tier 4: Portfolio overlap (Lowercarbon MCP)
Check for investments in the same space. Flag conflicts or
complementary portfolio companies.

### Tier 5: Past meeting notes (Granola)
Check for any prior meetings with these attendees.

### Tier 6: External context (web search)
For new deals, this tier is more important than for portfolio
meetings. Pull: founder backgrounds (FULL first and last names —
always), company website, funding history, recent press, competitive
landscape. But only AFTER exhausting internal sources.

## Context gathering — LP meetings

### Tier 1: Email threads (Gmail)
Recent correspondence. What have they been asking about? What was
last sent to them? Outstanding questions or commitments.

### Tier 2: Salesforce LP data (when available)
Fund commitments (which funds, amounts), contact history, relationship
owner, LP interests or concerns.

### Tier 3: Past meeting notes (Granola)
What was discussed at the last LP meeting.

### Tier 4: Suggest portfolio companies to discuss
Based on gathered context, propose 3-5 companies prioritized by:
a. Companies explicitly mentioned in recent email threads with this LP
b. Companies in their committed funds with notable recent updates
   (positive news to share, or issues they may have heard about)
c. Sector/stage overlap with LP's known interests

For each suggested company, include a 2-3 sentence summary of why
it's relevant and any recent highlights — pull this from the
Lowercarbon MCP and StandardMetrics.

### Tier 5: External context (web search)
Only to understand the LP's organization if it's a new relationship.

## Context gathering — INTERNAL meetings

Do NOT generate a briefing for routine standups or recurring 1:1s
unless the calendar description contains a specific agenda.

If there IS a specific agenda:
- Pull recent portfolio flags relevant to the agenda
- Note deals in pipeline that may be discussed
- Surface recent #dealflow activity

## Context gathering — UNKNOWN meetings

- Search email for threads with attendees
- Check Granola for past meetings
- Web search for attendee identity/role
- Keep the brief short

## Output format

Structure as a clean, scannable brief. Lead with what matters.

**Header:** Meeting title — attendee names — time

**Sections (include only those with real content):**

- **Why now** — What triggered this meeting. The email thread, the
  recurring cadence, the deal stage.
- **Key context** — The most important things to know walking in.
  What was last discussed, what's changed.
- **Open threads** — Unresolved questions, outstanding commitments
  from either side.
- **Numbers** (portfolio/deal only) — 3-5 key metrics. Not a
  spreadsheet.
- **Recent signal** — Slack chatter or news since the last
  interaction. Only if it adds something new.
- **Past meeting notes** — Key points from the last Granola
  transcript with these attendees.
- **Suggested discussion topics** (LP only) — Companies to be
  prepared to discuss, with brief rationale.

**Exclude:**
- Generic company overviews for companies the team knows well
- LinkedIn bios for people the user has met multiple times
- Boilerplate about the sector or market
- Anything already in the calendar invite description

## Key team members

Partners: Clay Dumas, Chris, Ryan Orbuch, Caie
Team: Clea Kolster, Scott Hsu, Duncan, Faris, Elena Mosse, Lauren

## Internal domains

lowercarbon.com, lowercarboncapital.com, lowercasellc.com

## Founder/CEO names

Always include full first and last names. If you only find a first name,
run a targeted search to find the full name before writing that section.
```

---

## Cron Configuration

NanoClaw supports scheduled tasks natively.

### Week 1: Simple single-pass (start here)

Run every 10 minutes. The agent checks the calendar, finds the next
meeting starting within 15 minutes, confirms it's still scheduled,
gathers context, and delivers. This is the simplest version — tune
the timing after you see how long a full research run takes.

```bash
nanoclaw cron add \
  --name "meeting-prep" \
  --cron "*/10 7-19 * * 1-5" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Check my calendar for meetings starting in the next 15 minutes. For any meeting you haven't already briefed me on today, first confirm it is still on the calendar and hasn't been cancelled or rescheduled. If confirmed, prepare a briefing following your meeting prep instructions. If cancelled or rescheduled, skip it and note it in your memory log. If there are no upcoming meetings or nothing meaningful to add, say nothing."
```

### Target architecture: Two-phase (after tuning)

Once you know how long research takes (e.g., 2-3 minutes per meeting),
split into two crons:

**Phase 1 — Research (runs every 30 min):**
Scan calendar for meetings in the next 3 hours. For each, gather context
from all relevant MCP servers and cache the results in agent memory.
Do not deliver yet.

**Phase 2 — Deliver (runs every 5 min):**
Check if any researched meeting starts in ~10 minutes. Re-check the
calendar to confirm it's still scheduled. If confirmed, format and
deliver the briefing to Slack DM. If cancelled/rescheduled, discard
and log it.

This separation means the agent has time to do thorough research
without time pressure, but delivery happens at the last responsible
moment with a fresh calendar confirmation.

### Conversational follow-up

After delivering a briefing, the agent remains available in the same
Slack DM thread. The user can reply with follow-up requests:
- "Pull up the full Dioxycle investor update"
- "What did Clay say about this in #dealflow last week?"
- "What were the action items from our last meeting with them?"

The agent uses the same MCP servers and context-gathering logic to
answer these on-demand.

### Deduplication

NanoClaw's persistent memory handles dedup naturally. The agent can write
to its memory log: "Briefed: [event_id] at [timestamp]" and check before
generating a new briefing. Include this in the CLAUDE.md:

```markdown
## Briefing deduplication

Before preparing a briefing, check your memory for whether you've already
briefed this specific calendar event (match on event title + time + date).
If you have, skip it. After sending a briefing, log it in your daily
memory file: "Briefed: [meeting title] at [time] for [date]"
```

---

## Slack Channel Allowlist

Maintain in `shared/slack-allowlist.json`:

```json
{
  "always_allowed": ["dealflow"],
  "portfolio_channels_match_mcp_names": true,
  "notes": "Portfolio company Slack channel names match their canonical name in the Lowercarbon MCP. e.g., Dioxycle → #dioxycle, Arc Boats → #arc-boats. The agent should derive the channel name from the company name found in the MCP."
}
```

Since channel names match MCP company names, the agent doesn't need a
separate lookup table. When it identifies a PORTFOLIO meeting and
canonicalizes the company name via the Lowercarbon MCP, it derives the
Slack channel name directly.

**Rules:**
- #dealflow is always searchable regardless of meeting type
- Portfolio company channels are only searchable for PORTFOLIO meetings
- No other channels are accessible

---

## Cost Estimate

**Infrastructure:**
- MacBook Pro (testing): $0 (already owned)
- Mac Mini M4 (production): ~$700 one-time
- Electricity: ~$5/month (15W continuous)

**API costs per briefing (~8-12 MCP tool calls, Sonnet 4.6):**
- ~20K input tokens + ~2K output tokens = ~$0.07-0.10
- NanoClaw process overhead: negligible

**Monthly for full team (8 people, ~5 external meetings/day each):**
- ~40 briefings/day × $0.08 avg = ~$3.20/day
- **~$70/month API costs for the full team**

**Total monthly (production):** ~$75 (API + electricity)

---

## Rollout Plan

### Week 1: Kyle prototype on MacBook Pro
- [ ] Set up 2017 MacBook Pro (disable sleep, SSH, Docker Desktop)
- [ ] Install NanoClaw, configure Kyle's agent
- [ ] Connect: Google Calendar, Gmail, Lowercarbon MCP, Granola (Option A — official remote MCP with OAuth)
- [ ] Write CLAUDE.md with system prompt
- [ ] Test manually: ask the agent to prep for a specific upcoming meeting
- [ ] Iterate on prompt and output format
- [ ] Set up simple 10-min cron, observe delivery timing

### Week 2: Add data sources, tune timing
- [ ] Add: StandardMetrics, Slack MCP (#dealflow + portfolio channels)
- [ ] Add: Affinity MCP (local stdio)
- [ ] Observe how long a full research run takes across all MCP servers
- [ ] Tune cron frequency and delivery window based on real data
- [ ] Consider splitting to two-phase cron if research takes >3 min
- [ ] Run for a full week, review briefing quality daily
- [ ] Refine system prompt based on real output

### Week 3: Onboard Caie
- [ ] Set up Caie's agent on the MacBook Pro (second agent directory)
- [ ] Have Caie auth her Google Calendar, Gmail, Granola
- [ ] She covers LP, portfolio, and new deal meetings — broadest test
- [ ] Collect feedback daily for a week, iterate on output format
- [ ] Pay attention to LP meeting flow (no Salesforce yet — how useful
      are the briefings with just email + Granola context?)

### Week 4: Production migration
- [ ] Buy Mac Mini M4 (16GB, 512GB SSD)
- [ ] Migrate NanoClaw setup from MacBook Pro
- [ ] Set up Tailscale, LuLu, launchd, UPS, dedicated non-admin user
- [ ] Onboard remaining team members (Clay, Ryan, etc.)

### Phase 2 (when ready):
- [ ] Stand up Salesforce MCP (Cloud Run or Composio) — LP meeting context
- [ ] Add LP fund commitment data to briefing flow
- [ ] Explore email triage as second automation
- [ ] Evaluate read-only dashboard for "what did the agents do this week"

---

## Open Questions

1. **Docker on 2017 Intel Mac:** Docker Desktop runs fine on Intel Macs
   but uses more resources than on Apple Silicon. Monitor memory usage
   with the first agent — if it's tight, reduce Docker's memory
   allocation in Docker Desktop preferences. Adding Caie as second
   agent on the same MacBook Pro may stress it — if so, that's the
   signal to move to Mac Mini sooner.

2. **Affinity MCP package name:** The `@affinity/mcp-server` package name
   in the config is a placeholder. Need to verify the actual npm package
   or whether to use the existing Affinity MCP setup from the current
   Claude.ai connector. If neither works as stdio, build a thin wrapper
   using the Affinity API. Affinity has a hosted MCP on their roadmap —
   when that ships, switch to the remote URL.

3. **Gmail OAuth for team members:** Google Workspace domain-wide
   delegation (service account) can provision Gmail + Calendar read
   access for all users without individual OAuth flows. Kyle has
   Workspace admin access. This simplifies onboarding significantly
   for production rollout.

4. **Granola paid plan:** Each user needs a paid Granola plan for
   access to notes beyond 30 days. Verify team members' plan status
   before onboarding.

5. **Slack DM delivery mechanism:** The briefing goes to the user's
   Slack DM. This could be via the Slack MCP's message posting
   capability or via the existing LC Slack bot infrastructure. Pairing
   the agent to the user's Slack DM as its primary channel enables
   both automated briefings AND conversational follow-up in the same
   thread.

6. **Salesforce MCP (Phase 2):** Deferred. LP meetings will rely on
   email + Granola context for now. During Caie's testing, observe
   how useful LP briefings are without Salesforce data — this will
   tell you how urgently to prioritize the Salesforce MCP buildout.

7. **Delivery timing tuning:** The 10-minute target is a starting
   point. After week 1, look at: how long does a full research run
   take? Are briefings arriving before meetings or too late? Is the
   cron frequency wasting API calls on empty time slots? Tune based
   on real data, not assumptions.

## Decisions Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Runtime | NanoClaw | OS-level isolation, Claude-native, minimal codebase |
| Test hardware | 2017 Intel MacBook Pro | Already owned, fine for 1-2 agents |
| Production hardware | Mac Mini M4 16GB 512GB | Community reference target |
| Granola MCP | Option A (official remote) | Consistent with multi-user setup |
| Second test user | Caie | Covers LP + portfolio + new deal meetings |
| Salesforce MCP | Phase 2 | LP-only, lower frequency, defer complexity |
| Slack channels | #dealflow always; portfolio channels match MCP names | Simple, no lookup table needed |
| Delivery timing | ~10 min before meeting, confirm still scheduled | Fresh context, handles rescheduling |
| Interaction model | Briefing + conversational follow-up in same Slack DM | Stickier, more useful from day one |
