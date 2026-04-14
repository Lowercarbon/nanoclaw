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

// Field ID to readable name mapping for the LC Deal Log (list 205572)
const FIELD_MAP: Record<string, string> = {
  'field-3832132': 'Deal Stage',
  'field-5092585': 'Deal Team',
  'field-3860236': 'Deal Notes',
  'field-3832139': 'Pass Reason',
  'field-4741256': 'Pass Details',
  'field-3832137': 'Investment Round',
  'field-4831812': 'Raise Size',
  'field-4831811': 'Pre-Money Valuation',
  'field-3832140': 'Deal Source: Person',
  'field-3832141': 'Deal Source: Org',
  'field-3832135': 'Deal Source: Channel',
  'field-4144018': 'Gut Check',
  'field-4163630': 'Follow On',
  'field-3857151': 'Proprietary',
  'field-3836800': 'Deal Start Date',
  'field-3836801': 'Deal Close Date',
};

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
        const result = (await affinityFetch('/companies', {
          term: args.query,
          page_size: '10',
        })) as {
          data?: Array<{
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

        const companies = result.data || [];
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
        // Step 1: Get list entries for this company
        const entriesResult = (await affinityFetch(
          `/companies/${args.company_id}/list-entries`,
        )) as { data?: Array<{ id: number; list_id: number }> };

        const entries = entriesResult.data || [];
        const dealLogEntry = entries.find((e) => e.list_id === DEAL_LOG_LIST_ID);

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

        // Step 2: Get full list entry with all field types
        const entryResult = (await affinityFetch(
          `/lists/${DEAL_LOG_LIST_ID}/list-entries/${dealLogEntry.id}`,
          { field_types: 'enriched,global,relationship-intelligence,list' },
        )) as {
          data?: {
            id: number;
            entity?: { id: number; name: string };
            fields?: Array<{
              field_id: string;
              value: unknown;
            }>;
          };
        };

        const entry = entryResult.data || entryResult;
        const fields = (entry as { fields?: Array<{ field_id: string; value: unknown }> }).fields || [];

        // Map field IDs to readable names
        const fieldLines: string[] = [];
        for (const field of fields) {
          const readableName = FIELD_MAP[field.field_id];
          if (readableName) {
            const value = formatFieldValue(field.value);
            if (value) {
              fieldLines.push(`${readableName}: ${value}`);
            }
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
