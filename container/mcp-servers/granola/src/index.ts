/**
 * Granola MCP Proxy Server for NanoClaw
 *
 * Proxies calls to Granola's Streamable HTTP MCP endpoint for meeting notes.
 * Tools: query_granola_meetings, list_granola_meetings, get_granola_meeting.
 * Auth: reads access token from GRANOLA_TOKEN_PATH file.
 *
 * IMPORTANT: Preserves the SSE fix from commit 2b8bbcf — Granola streams
 * many progress notifications before the final result. We skip any SSE
 * data lines where method === 'notifications/progress'.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { pathToFileURL } from 'url';

import { callGranolaTool } from './granola-client.js';

const GRANOLA_TOKEN_PATH = process.env.GRANOLA_TOKEN_PATH || '';

function log(msg: string): void {
  process.stderr.write(`[granola-mcp] ${msg}\n`);
}

async function main(): Promise<void> {
  if (!GRANOLA_TOKEN_PATH) {
    throw new Error('Missing GRANOLA_TOKEN_PATH environment variable');
  }

  const server = new McpServer({
    name: 'granola',
    version: '1.0.0',
  });

  server.tool(
    'query_granola_meetings',
    'Search Granola meeting notes using natural language. Returns meeting content with citation links. Use for questions about what was discussed, decided, action items, or follow-ups from past meetings.',
    {
      query: z.string().describe('Natural language query about meeting content'),
      document_ids: z
        .array(z.string())
        .optional()
        .describe('Optional list of specific meeting IDs to search within'),
    },
    async (args: { query: string; document_ids?: string[] }) => {
      try {
        const result = await callGranolaTool('query_granola_meetings', args);
        return { content: [{ type: 'text' as const, text: result }] };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Granola error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'list_granola_meetings',
    'List Granola meeting notes within a time range. Returns meeting titles and metadata.',
    {
      time_range: z
        .enum(['this_week', 'last_week', 'last_30_days', 'custom'])
        .default('last_30_days')
        .describe('Time range to query'),
      custom_start: z
        .string()
        .optional()
        .describe('ISO date for custom range start'),
      custom_end: z
        .string()
        .optional()
        .describe('ISO date for custom range end'),
    },
    async (args: {
      time_range: 'this_week' | 'last_week' | 'last_30_days' | 'custom';
      custom_start?: string;
      custom_end?: string;
    }) => {
      try {
        const result = await callGranolaTool('list_meetings', args);
        return { content: [{ type: 'text' as const, text: result }] };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Granola error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'get_granola_meeting',
    'Get detailed meeting info by ID — private notes, AI summary, attendees. Use after finding meeting IDs from list_granola_meetings.',
    {
      meeting_ids: z
        .array(z.string())
        .min(1)
        .max(10)
        .describe('Array of meeting UUIDs (max 10)'),
    },
    async (args: { meeting_ids: string[] }) => {
      try {
        const result = await callGranolaTool('get_meetings', args);
        return { content: [{ type: 'text' as const, text: result }] };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Granola error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  log('Starting Granola MCP proxy server...');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('Server connected');
}

const isMainModule =
  process.argv[1] != null &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMainModule) {
  main().catch((err) => {
    log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
