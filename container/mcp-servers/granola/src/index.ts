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
import { readFileSync } from 'fs';

const GRANOLA_TOKEN_PATH = process.env.GRANOLA_TOKEN_PATH || '';

function log(msg: string): void {
  process.stderr.write(`[granola-mcp] ${msg}\n`);
}

let granolaAccessToken = '';

function loadGranolaToken(): void {
  try {
    const token = JSON.parse(readFileSync(GRANOLA_TOKEN_PATH, 'utf-8'));
    granolaAccessToken = token.access_token || '';
  } catch {
    granolaAccessToken = '';
  }
}

// Call a tool on Granola's Streamable HTTP MCP endpoint
async function callGranolaTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (!granolaAccessToken) loadGranolaToken();
  if (!granolaAccessToken) throw new Error('No Granola access token');

  const body = {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: toolName, arguments: args },
    id: Date.now(),
  };

  const resp = await fetch('https://mcp.granola.ai/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${granolaAccessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });

  if (resp.status === 401) {
    throw new Error(
      'Granola token expired. Re-run: npx tsx scripts/granola-auth.ts',
    );
  }

  const text = await resp.text();
  // Parse SSE response — Granola streams many progress notifications
  // before the final result. We need the last data line that has a "result" key.
  // FIX (2b8bbcf): Skip progress notifications to avoid returning partial data.
  const lines = text.split('\n');
  let finalResult: string | null = null;

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    try {
      const data = JSON.parse(line.slice(6)) as {
        result?: { content?: Array<{ type: string; text?: string }> };
        error?: { message: string };
        method?: string;
      };
      // Skip progress notifications
      if (data.method === 'notifications/progress') continue;
      if (data.error) throw new Error(data.error.message);
      if (data.result?.content) {
        const parts = data.result.content
          .filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text!);
        if (parts.length > 0) {
          finalResult = parts.join('\n');
        }
      }
    } catch (e) {
      if (e instanceof Error && e.message !== 'Unexpected end of JSON input') {
        throw e;
      }
    }
  }

  return finalResult || '(no content returned)';
}

async function main(): Promise<void> {
  if (!GRANOLA_TOKEN_PATH) {
    throw new Error('Missing GRANOLA_TOKEN_PATH environment variable');
  }

  loadGranolaToken();

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
    async (args) => {
      try {
        const result = await callGranolaTool(
          'query_granola_meetings',
          args,
        );
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
    async (args) => {
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
    async (args) => {
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

  // Start server
  log('Starting Granola MCP proxy server...');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('Server connected');
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
