/**
 * Lowercarbon MCP Proxy Server for NanoClaw
 *
 * Proxies calls to the remote Vectorize-hosted Lowercarbon MCP endpoint.
 * Tools: portfolio_documents, get_company_facts, get_portfolio_facts.
 * Auth: LC_MCP_URL + LC_MCP_API_KEY from environment.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const LC_MCP_URL = process.env.LC_MCP_URL || '';
const LC_MCP_API_KEY = process.env.LC_MCP_API_KEY || '';

function log(msg: string): void {
  process.stderr.write(`[lowercarbon-mcp] ${msg}\n`);
}

// Helper: call a tool on the remote Vectorize MCP endpoint
async function callLcMcpTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const body = {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: toolName, arguments: args },
    id: Date.now(),
  };

  const resp = await fetch(LC_MCP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${LC_MCP_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = (await resp.json()) as {
    result?: { content?: Array<{ type: string; text?: string }> };
    error?: { message: string };
  };

  if (data.error) {
    throw new Error(data.error.message);
  }

  const textParts =
    data.result?.content
      ?.filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text!) || [];
  return textParts.join('\n') || '(no content returned)';
}

async function main(): Promise<void> {
  if (!LC_MCP_URL || !LC_MCP_API_KEY) {
    throw new Error(
      'Missing LC_MCP_URL or LC_MCP_API_KEY environment variables',
    );
  }

  const server = new McpServer({
    name: 'lowercarbon',
    version: '1.0.0',
  });

  server.tool(
    'portfolio_documents',
    'Search Lowercarbon portfolio company documents — investor updates, internal updates, slack messages, financing history, board notes, investment memos. This is the primary source for portfolio company context.',
    {
      question: z.string().describe('The search query'),
      company: z
        .string()
        .optional()
        .describe('Filter results to a specific portfolio company name'),
      doc_type: z
        .string()
        .optional()
        .describe(
          'Filter by document type: investor_update, board_notes, board_deck, investment_memo, slack_message',
        ),
      k: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(10)
        .describe('Number of documents to retrieve (default 10)'),
    },
    async (args) => {
      try {
        const result = await callLcMcpTool('portfolio-documents', args);
        return {
          content: [{ type: 'text' as const, text: result }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `LC MCP error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'get_company_facts',
    'Get quantitative investment data for a specific portfolio company — investment amount, ownership percentage, MOIC, round details.',
    {
      question: z.string().describe('The search query'),
      company: z
        .string()
        .optional()
        .describe('Filter results to a specific portfolio company name'),
      k: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(5)
        .describe('Number of documents to retrieve (default 5)'),
    },
    async (args) => {
      try {
        const result = await callLcMcpTool('get-company-facts', args);
        return {
          content: [{ type: 'text' as const, text: result }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `LC MCP error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'get_portfolio_facts',
    'Query portfolio-level facts — portfolio count, categories, holistic portfolio questions. Use this to confirm whether a company is in the LC portfolio.',
    {
      question: z.string().describe('The search query'),
      k: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(5)
        .describe('Number of documents to retrieve (default 5)'),
    },
    async (args) => {
      try {
        const result = await callLcMcpTool('get-portfolio-facts', args);
        return {
          content: [{ type: 'text' as const, text: result }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `LC MCP error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // Start server
  log('Starting Lowercarbon MCP proxy server...');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('Server connected');
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
