/**
 * Slack MCP Server for NanoClaw
 *
 * Provides read-only access to Slack channels and messages via stdio MCP protocol.
 * Auth: reads SLACK_BOT_TOKEN from environment.
 * Uses Node.js built-in fetch (no Slack SDK dependency).
 *
 * Tools:
 *   - search_slack_channel: find channels by name
 *   - search_slack_messages: read channel history with file attachment metadata
 *   - download_slack_file: fetch file content via url_private_download
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';

function log(msg: string): void {
  process.stderr.write(`[slack-mcp] ${msg}\n`);
}

// --- Types ---

interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private_download?: string;
}

interface SlackMessage {
  user?: string;
  text: string;
  ts: string;
  files?: SlackFile[];
}

// --- Helpers ---

function formatFileInfo(file: SlackFile): string {
  const sizeMb = (file.size / (1024 * 1024)).toFixed(2);
  const downloadUrl = file.url_private_download || 'N/A';
  return `    [File] ${file.name} (id=${file.id}, type=${file.mimetype}, size=${sizeMb}MB, download_url=${downloadUrl})`;
}

// --- Main ---

async function main(): Promise<void> {
  if (!SLACK_BOT_TOKEN) {
    throw new Error('Missing SLACK_BOT_TOKEN environment variable');
  }

  const server = new McpServer({
    name: 'slack',
    version: '1.0.0',
  });

  // ============ search_slack_channel ============

  server.tool(
    'search_slack_channel',
    'Search for a Slack channel by name. Use this to find the correct channel for a portfolio company before searching messages. Returns channel ID, name, and member count.',
    {
      name: z
        .string()
        .describe(
          'Channel name to search for (e.g. "Senra", "Arc Boats", "Dioxycle"). Case-insensitive partial match.',
        ),
    },
    async (args) => {
      try {
        const searchName = args.name.toLowerCase();
        let matchedChannels: Array<{
          id: string;
          name: string;
          num_members: number;
        }> = [];
        let cursor: string | undefined;

        // Paginate through channels to find matches
        do {
          const url = new URL('https://slack.com/api/conversations.list');
          url.searchParams.set('types', 'public_channel');
          url.searchParams.set('exclude_archived', 'true');
          url.searchParams.set('limit', '200');
          if (cursor) url.searchParams.set('cursor', cursor);

          const resp = await fetch(url.toString(), {
            headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
          });
          const data = (await resp.json()) as {
            ok: boolean;
            error?: string;
            channels?: Array<{
              id: string;
              name: string;
              num_members: number;
            }>;
            response_metadata?: { next_cursor?: string };
          };

          if (!data.ok) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Slack API error: ${data.error || 'unknown'}`,
                },
              ],
              isError: true,
            };
          }

          for (const ch of data.channels || []) {
            if (ch.name.toLowerCase().includes(searchName)) {
              matchedChannels.push({
                id: ch.id,
                name: ch.name,
                num_members: ch.num_members,
              });
            }
          }

          cursor = data.response_metadata?.next_cursor || undefined;
        } while (cursor && matchedChannels.length === 0);

        if (matchedChannels.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No Slack channel found matching "${args.name}".`,
              },
            ],
          };
        }

        const lines = matchedChannels.map(
          (ch) => `#${ch.name} (ID: ${ch.id}, ${ch.num_members} members)`,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `Found ${matchedChannels.length} channel(s) matching "${args.name}":\n\n${lines.join('\n')}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error searching Slack channels: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ============ search_slack_messages ============

  server.tool(
    'search_slack_messages',
    'Search for messages in a Slack channel. Use after finding the channel ID with search_slack_channel. Returns message text and any file attachments (name, ID, mimetype, size, download URL) when present.',
    {
      channel_id: z.string().describe('Slack channel ID (e.g. "C0ABC123")'),
      query: z
        .string()
        .optional()
        .describe(
          'Optional text to search for within the channel. If omitted, returns the most recent messages.',
        ),
      days: z
        .number()
        .int()
        .default(30)
        .describe(
          'How many days back to search (default 30)',
        ),
      max_results: z
        .number()
        .int()
        .default(20)
        .describe('Maximum messages to return (default 20, max 50)'),
    },
    async (args) => {
      try {
        const oldest = Math.floor(
          (Date.now() - args.days * 24 * 60 * 60 * 1000) / 1000,
        );

        const url = new URL(
          'https://slack.com/api/conversations.history',
        );
        url.searchParams.set('channel', args.channel_id);
        url.searchParams.set('oldest', String(oldest));
        url.searchParams.set(
          'limit',
          String(Math.min(args.max_results, 50)),
        );

        const resp = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
        });
        let data = (await resp.json()) as {
          ok: boolean;
          error?: string;
          messages?: SlackMessage[];
        };

        if (!data.ok) {
          if (data.error === 'not_in_channel') {
            // Auto-join the channel and retry
            log(`Not in channel ${args.channel_id}, attempting to join...`);
            const joinResp = await fetch(
              'https://slack.com/api/conversations.join',
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ channel: args.channel_id }),
              },
            );
            const joinData = (await joinResp.json()) as {
              ok: boolean;
              error?: string;
            };
            if (!joinData.ok) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Could not auto-join channel: ${joinData.error || 'unknown'}. For private channels, the bot must be invited manually.`,
                  },
                ],
                isError: true,
              };
            }
            log(`Joined channel ${args.channel_id}, retrying message fetch...`);

            // Retry the history fetch
            const retryResp = await fetch(url.toString(), {
              headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
            });
            data = (await retryResp.json()) as typeof data;
            if (!data.ok) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Joined channel but still can't read messages: ${data.error || 'unknown'}`,
                  },
                ],
                isError: true,
              };
            }
            // Fall through to process messages below
          } else {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Slack API error: ${data.error || 'unknown'}`,
                },
              ],
              isError: true,
            };
          }
        }

        let messages = data.messages || [];

        // Filter by query text if provided
        if (args.query) {
          const q = args.query.toLowerCase();
          messages = messages.filter((m) =>
            m.text.toLowerCase().includes(q),
          );
        }

        if (messages.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No messages found in channel${args.query ? ` matching "${args.query}"` : ''} in the last ${args.days} days.`,
              },
            ],
          };
        }

        // Count files across all messages
        let totalFiles = 0;

        const formatted = messages.map((msg) => {
          const date = new Date(
            parseFloat(msg.ts) * 1000,
          ).toISOString();
          const user = msg.user || 'unknown';
          const text =
            msg.text.length > 500
              ? msg.text.slice(0, 500) + '...'
              : msg.text;

          let line = `[${date}] <@${user}>: ${text}`;

          // Include file attachment metadata when present
          if (msg.files && msg.files.length > 0) {
            totalFiles += msg.files.length;
            const fileLines = msg.files.map(formatFileInfo);
            line += '\n' + fileLines.join('\n');
          }

          return line;
        });

        let summary = `Found ${messages.length} messages (last ${args.days} days)`;
        if (totalFiles > 0) {
          summary += `, ${totalFiles} file attachment(s)`;
        }
        summary += ':\n\n' + formatted.join('\n\n');

        return {
          content: [
            {
              type: 'text' as const,
              text: summary,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error searching Slack messages: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ============ download_slack_file ============

  server.tool(
    'download_slack_file',
    'Download a file from Slack using its private download URL. Returns the file content as base64 data. Use this to retrieve pitch decks, board materials, or other documents uploaded to Slack channels. Get the download URL from search_slack_messages file metadata.',
    {
      url: z
        .string()
        .describe(
          'The url_private_download URL from a Slack file (from search_slack_messages file metadata). Must start with https://files.slack.com/',
        ),
      filename: z
        .string()
        .optional()
        .describe(
          'Optional filename to include in the response. If omitted, extracted from the URL.',
        ),
    },
    async (args) => {
      try {
        // Validate the URL is a Slack file URL
        if (!args.url.startsWith('https://files.slack.com/')) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Invalid URL: must be a Slack file URL starting with https://files.slack.com/',
              },
            ],
            isError: true,
          };
        }

        log(`Downloading file: ${args.url}`);

        const resp = await fetch(args.url, {
          headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
        });

        if (!resp.ok) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Failed to download file: HTTP ${resp.status} ${resp.statusText}`,
              },
            ],
            isError: true,
          };
        }

        const contentType = resp.headers.get('content-type') || 'application/octet-stream';
        const buffer = Buffer.from(await resp.arrayBuffer());
        const base64 = buffer.toString('base64');

        // Determine filename
        let name = args.filename;
        if (!name) {
          // Extract from URL path
          const urlPath = new URL(args.url).pathname;
          const segments = urlPath.split('/');
          name = segments[segments.length - 1] || 'download';
          // Decode URI-encoded characters
          name = decodeURIComponent(name);
        }

        const sizeMb = (buffer.length / (1024 * 1024)).toFixed(2);
        log(`Downloaded ${name} (${sizeMb}MB, ${contentType})`);

        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `File: ${name}`,
                `Size: ${sizeMb}MB`,
                `Content-Type: ${contentType}`,
                `Base64 length: ${base64.length} chars`,
                '',
                `<base64>${base64}</base64>`,
              ].join('\n'),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error downloading Slack file: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // Start server
  log('Starting Slack MCP server...');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('Server connected');
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
