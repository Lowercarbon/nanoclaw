/**
 * Affinity MCP Server for NanoClaw
 *
 * Provides read-only access to Affinity CRM via REST API v2.
 * Tools: search_affinity_companies, get_deal_log_entry, get_affinity_notes.
 * Auth: AFFINITY_API_KEY from environment (Bearer token).
 *
 * Uses Node.js built-in fetch — no additional HTTP dependencies.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const AFFINITY_API_KEY = process.env.AFFINITY_API_KEY || '';
const BASE_URL = 'https://api.affinity.co/v2';
const DEAL_LOG_LIST_ID = 205572;

function log(msg: string): void {
  process.stderr.write(`[affinity-mcp] ${msg}\n`);
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// No static field ID mapping needed — the v2 API returns human-readable
// field names directly. The old FIELD_MAP with `field-NNNNNNN` IDs was
// from the v1 API which used numeric field IDs.

// v2 API: Bearer auth. Used for list entries, notes, etc.
async function affinityFetch(
  path: string,
  params?: Record<string, string>,
  retryOn429 = true,
): Promise<unknown> {
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const resp = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${AFFINITY_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  if (resp.status === 429 && retryOn429) {
    log('Rate limited (429), retrying after 2s...');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return affinityFetch(path, params, false);
  }

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Affinity API error: ${resp.status} ${resp.statusText} — ${body}`);
  }

  return resp.json();
}

// v1 API: Basic auth (empty username, API key as password).
// The v2 /companies endpoint does NOT support text search — the `term`
// parameter is silently ignored. Company search requires the v1 /organizations
// endpoint which accepts `term` and returns ranked results.
const V1_BASE_URL = 'https://api.affinity.co';

async function affinityV1Fetch(
  path: string,
  params?: Record<string, string>,
  retryOn429 = true,
): Promise<unknown> {
  const url = new URL(`${V1_BASE_URL}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const basicAuth = Buffer.from(`:${AFFINITY_API_KEY}`).toString('base64');
  const resp = await fetch(url.toString(), {
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/json',
    },
  });

  if (resp.status === 429 && retryOn429) {
    log('Rate limited (429), retrying after 2s...');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return affinityV1Fetch(path, params, false);
  }

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Affinity v1 API error: ${resp.status} ${resp.statusText} — ${body}`);
  }

  return resp.json();
}

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    return value
      .map((v) => {
        if (typeof v === 'object' && v !== null) {
          // Person or company references
          if ('first_name' in v && 'last_name' in v) {
            return `${(v as { first_name: string }).first_name} ${(v as { last_name: string }).last_name}`;
          }
          if ('name' in v) return (v as { name: string }).name;
          if ('text' in v) return (v as { text: string }).text;
          return JSON.stringify(v);
        }
        return String(v);
      })
      .join(', ');
  }
  if (typeof value === 'object' && value !== null) {
    if ('text' in value) return (value as { text: string }).text;
    if ('name' in value) return (value as { name: string }).name;
    if ('first_name' in value && 'last_name' in value) {
      return `${(value as { first_name: string }).first_name} ${(value as { last_name: string }).last_name}`;
    }
    return JSON.stringify(value);
  }
  return String(value);
}

async function main(): Promise<void> {
  if (!AFFINITY_API_KEY) {
    throw new Error('Missing AFFINITY_API_KEY environment variable');
  }

  const server = new McpServer({
    name: 'affinity',
    version: '1.0.0',
  });

  // ============ TOOLS ============

  server.tool(
    'search_affinity_companies',
    'Search Affinity for a company by name or domain. Returns company ID, name, and domain. Use this as the entry point for Affinity lookups — if no match, the company is not tracked in Affinity.',
    {
      query: z.string().describe('Company name or domain to search for'),
    },
    async (args) => {
      try {
        // v1 /organizations endpoint supports text search (v2 /companies does not)
        const result = (await affinityV1Fetch('/organizations', {
          term: args.query,
          page_size: '10',
        })) as {
          organizations?: Array<{
            id: number;
            name: string;
            domain?: string;
            domains?: string[];
            interaction_dates?: {
              first_email_date?: string;
              last_email_date?: string;
              first_event_date?: string;
              last_event_date?: string;
            };
          }>;
        };

        const companies = result.organizations || [];
        if (companies.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No companies found in Affinity matching "${args.query}".`,
              },
            ],
          };
        }

        const lines = companies.map((c) => {
          const domain = c.domain || (c.domains && c.domains[0]) || 'no domain';
          const dates = c.interaction_dates;
          const interactionInfo = dates
            ? `, last email: ${dates.last_email_date || 'none'}, last event: ${dates.last_event_date || 'none'}`
            : '';
          return `- ${c.name} (ID: ${c.id}, domain: ${domain}${interactionInfo})`;
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: `Found ${companies.length} companies matching "${args.query}":\n\n${lines.join('\n')}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Affinity error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'get_deal_log_entry',
    'Check if a company is on the Lowercarbon Deal Log and pull deal fields (stage, team, notes, round, valuation, source, pass reason). Returns null if the company is not on the Deal Log.',
    {
      company_id: z.string().describe('Affinity company ID (from search_affinity_companies)'),
    },
    async (args) => {
      try {
        // The v2 /companies/{id}/list-entries endpoint returns entries
        // WITH fields included — no second API call needed.
        const entriesResult = (await affinityFetch(
          `/companies/${args.company_id}/list-entries`,
        )) as {
          data?: Array<{
            id: number;
            listId: number;
            createdAt?: string;
            entity?: { id: number; name: string };
            fields?: Array<{
              id: string;
              name: string;
              value: { type: string; data: unknown } | null;
            }>;
          }>;
        };

        const entries = entriesResult.data || [];
        const dealLogEntry = entries.find((e) => e.listId === DEAL_LOG_LIST_ID);

        if (!dealLogEntry) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Company ${args.company_id} is not on the Deal Log (list ${DEAL_LOG_LIST_ID}).`,
              },
            ],
          };
        }

        // Extract fields — v2 uses {id, name, value: {type, data}} shape.
        // Surface fields with non-null data, using the human-readable `name`.
        const fields = dealLogEntry.fields || [];
        const fieldLines: string[] = [];

        if (dealLogEntry.createdAt) {
          fieldLines.push(
            `Added to Deal Log: ${new Date(dealLogEntry.createdAt).toISOString().split('T')[0]}`,
          );
        }

        for (const field of fields) {
          if (!field.value || field.value.data === null || field.value.data === undefined) continue;
          const data = field.value.data;
          let formatted: string;

          if (typeof data === 'string') {
            formatted = data;
          } else if (typeof data === 'number') {
            formatted = String(data);
          } else if (typeof data === 'boolean') {
            formatted = data ? 'Yes' : 'No';
          } else if (Array.isArray(data)) {
            const items = data.filter((v) => v !== null);
            if (items.length === 0) continue;
            formatted = items.join(', ');
          } else if (typeof data === 'object' && data !== null) {
            // Person or entity reference
            const obj = data as Record<string, unknown>;
            if (obj.firstName && obj.lastName) {
              formatted = `${obj.firstName} ${obj.lastName}`;
            } else if (obj.name) {
              formatted = obj.name as string;
            } else if (obj.text) {
              formatted = obj.text as string;
            } else {
              formatted = JSON.stringify(data);
            }
          } else {
            continue;
          }

          if (formatted && formatted.length > 0) {
            fieldLines.push(`${field.name}: ${formatted}`);
          }
        }

        if (fieldLines.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Company ${args.company_id} is on the Deal Log (entry ${dealLogEntry.id}) but has no populated deal fields.`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `Deal Log entry for company ${args.company_id}:\n\n${fieldLines.join('\n')}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Affinity error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'get_affinity_notes',
    'Get internal notes attached to a company in Affinity. Returns up to 10 most recent notes with content (HTML stripped), creator name, and date.',
    {
      company_id: z.string().describe('Affinity company ID (from search_affinity_companies)'),
    },
    async (args) => {
      try {
        const result = (await affinityFetch(
          `/companies/${args.company_id}/notes`,
        )) as {
          data?: Array<{
            id: number;
            content: string;
            created_at: string;
            creator?: { first_name?: string; last_name?: string; email?: string };
            type?: string;
          }>;
        };

        const notes = (result.data || [])
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
          .slice(0, 10);

        if (notes.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No notes found for company ${args.company_id} in Affinity.`,
              },
            ],
          };
        }

        const formatted = notes.map((note) => {
          const creator = note.creator
            ? `${note.creator.first_name || ''} ${note.creator.last_name || ''}`.trim() ||
              note.creator.email ||
              'Unknown'
            : 'Unknown';
          const date = note.created_at
            ? new Date(note.created_at).toISOString().split('T')[0]
            : 'unknown date';
          const content = stripHtml(note.content || '');
          const truncated =
            content.length > 1000
              ? content.slice(0, 1000) + '\n... (truncated)'
              : content;
          const noteType = note.type || 'manual';
          return `[${date}] by ${creator} (${noteType}):\n${truncated}`;
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: `Found ${notes.length} notes for company ${args.company_id}:\n\n${formatted.join('\n\n---\n\n')}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Affinity error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // Start server
  log('Starting Affinity MCP server...');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('Server connected');
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
