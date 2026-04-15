/**
 * Slack MCP Server for NanoClaw
 *
 * Provides read-only access to Slack channels and messages via stdio MCP protocol.
 * Auth: reads SLACK_BOT_TOKEN (required) and SLACK_USER_TOKEN (optional) from environment.
 * Uses Node.js built-in fetch (no Slack SDK dependency).
 *
 * When SLACK_USER_TOKEN is available, search_slack_messages uses Slack's
 * search.messages API for relevance-ranked results across all time.
 * Without it, falls back to conversations.history (time-windowed, no ranking).
 *
 * Tools:
 *   - search_slack_channel: find channels by name
 *   - search_slack_messages: search/browse channel messages with file attachment metadata
 *   - get_slack_thread: expand a thread to see all replies
 *   - download_slack_file: fetch file content via url_private_download
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { writeFileSync, mkdirSync, copyFileSync, renameSync } from 'fs';
import path from 'path';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const SLACK_USER_TOKEN = process.env.SLACK_USER_TOKEN || '';
const IPC_CHAT_JID = process.env.NANOCLAW_CHAT_JID || '';
const IPC_GROUP_FOLDER = process.env.NANOCLAW_GROUP_FOLDER || '';

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
  channel?: { id: string; name: string };
  permalink?: string;
}

interface SlackSearchMatch {
  iid: string;
  ts: string;
  text: string;
  user: string;
  username: string;
  channel: { id: string; name: string };
  permalink: string;
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
    'Search for messages in a Slack channel. Use after finding the channel ID with search_slack_channel. Returns message text and any file attachments (name, ID, mimetype, size, download URL) when present. When a query is provided, uses Slack search API for relevance-ranked results across all time. Without a query, returns the most recent messages.',
    {
      channel_id: z.string().describe('Slack channel ID (e.g. "C0ABC123")'),
      query: z
        .string()
        .optional()
        .describe(
          'Search query — results are ranked by relevance across all time (not limited to a time window). If omitted, returns the most recent messages chronologically.',
        ),
      days: z
        .number()
        .int()
        .default(90)
        .describe(
          'How many days back to look when browsing without a query (default 90). Ignored when query is provided (search spans all time).',
        ),
      max_results: z
        .number()
        .int()
        .default(20)
        .describe('Maximum messages to return (default 20, max 50)'),
    },
    async (args) => {
      try {
        // --- Path A: query provided → use search.messages for relevance ranking ---
        if (args.query && SLACK_USER_TOKEN) {
          log(`Searching channel ${args.channel_id} for "${args.query}" via search.messages`);
          const searchUrl = new URL('https://slack.com/api/search.messages');
          searchUrl.searchParams.set('query', `${args.query} in:<#${args.channel_id}>`);
          searchUrl.searchParams.set('count', String(Math.min(args.max_results, 50)));
          searchUrl.searchParams.set('sort', 'score');

          const searchResp = await fetch(searchUrl.toString(), {
            headers: { Authorization: `Bearer ${SLACK_USER_TOKEN}` },
          });
          const searchData = (await searchResp.json()) as {
            ok: boolean;
            error?: string;
            messages?: {
              total: number;
              matches: SlackSearchMatch[];
            };
          };

          if (!searchData.ok) {
            log(`search.messages failed: ${searchData.error}, falling back to conversations.history`);
            // Fall through to Path B below
          } else {
            const matches = searchData.messages?.matches || [];

            if (matches.length === 0) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `No messages found in channel matching "${args.query}" (searched all time, ${searchData.messages?.total || 0} total results).`,
                  },
                ],
              };
            }

            let totalFiles = 0;
            const formatted = matches.map((match) => {
              const date = new Date(parseFloat(match.ts) * 1000).toISOString();
              const user = match.username || match.user || 'unknown';
              const text =
                match.text.length > 500
                  ? match.text.slice(0, 500) + '...'
                  : match.text;

              let line = `[${date}] (ts=${match.ts}) <@${user}>: ${text}`;

              if (match.files && match.files.length > 0) {
                totalFiles += match.files.length;
                const fileLines = match.files.map(formatFileInfo);
                line += '\n' + fileLines.join('\n');
              }

              if (match.permalink) {
                line += `\n    [permalink: ${match.permalink}]`;
              }

              return line;
            });

            let summary = `Found ${matches.length} messages matching "${args.query}" (ranked by relevance, searched all time)`;
            if (totalFiles > 0) {
              summary += `, ${totalFiles} file attachment(s)`;
            }
            summary += ':\n\n' + formatted.join('\n\n');

            return {
              content: [{ type: 'text' as const, text: summary }],
            };
          }
        }

        // --- Path B: no query or no user token → conversations.history ---
        if (args.query && !SLACK_USER_TOKEN) {
          log('No SLACK_USER_TOKEN — falling back to conversations.history (no relevance ranking)');
        }

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

        const messages = data.messages || [];

        if (messages.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No messages found in channel in the last ${args.days} days.`,
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

          let line = `[${date}] (ts=${msg.ts}) <@${user}>: ${text}`;

          // Include file attachment metadata when present
          if (msg.files && msg.files.length > 0) {
            totalFiles += msg.files.length;
            const fileLines = msg.files.map(formatFileInfo);
            line += '\n' + fileLines.join('\n');
          }

          return line;
        });

        let summary = `Found ${messages.length} messages (last ${args.days} days)`;
        if (args.query) {
          summary += ` [no search ranking available — scan all messages for "${args.query}"]`;
        }
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

  // ============ get_slack_thread ============

  server.tool(
    'get_slack_thread',
    'Get all replies in a Slack thread. Use after search_slack_messages to expand a thread and see the full conversation. Thread replies often contain the most valuable context (reactions, concerns, follow-ups).',
    {
      channel_id: z.string().describe('Slack channel ID'),
      thread_ts: z
        .string()
        .describe(
          'Timestamp of the parent message (the "ts" field from search_slack_messages results). This identifies the thread.',
        ),
    },
    async (args) => {
      try {
        const url = new URL('https://slack.com/api/conversations.replies');
        url.searchParams.set('channel', args.channel_id);
        url.searchParams.set('ts', args.thread_ts);
        url.searchParams.set('limit', '50');

        const resp = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
        });
        const data = (await resp.json()) as {
          ok: boolean;
          error?: string;
          messages?: SlackMessage[];
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

        const messages = data.messages || [];

        if (messages.length <= 1) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'No replies in this thread (only the parent message).',
              },
            ],
          };
        }

        // Skip the first message (parent) — the agent already has it from search
        const replies = messages.slice(1);
        let totalFiles = 0;

        const formatted = replies.map((msg) => {
          const date = new Date(parseFloat(msg.ts) * 1000).toISOString();
          const user = msg.user || 'unknown';
          const text =
            msg.text.length > 500
              ? msg.text.slice(0, 500) + '...'
              : msg.text;

          let line = `[${date}] <@${user}>: ${text}`;

          if (msg.files && msg.files.length > 0) {
            totalFiles += msg.files.length;
            const fileLines = msg.files.map(formatFileInfo);
            line += '\n' + fileLines.join('\n');
          }

          return line;
        });

        let summary = `Thread has ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`;
        if (totalFiles > 0) {
          summary += `, ${totalFiles} file attachment(s)`;
        }
        summary += ':\n\n' + formatted.join('\n\n');

        return {
          content: [{ type: 'text' as const, text: summary }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error fetching thread: ${err instanceof Error ? err.message : String(err)}`,
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
    'Download a Slack file, save it to a company folder, and send it to the user as a chat attachment. All three happen automatically — no need to call send_file.',
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
          'Optional filename. If omitted, extracted from the URL.',
        ),
      save_dir: z
        .string()
        .optional()
        .describe(
          'Directory to save (e.g. "/workspace/group/companies/{slug}/attachments")',
        ),
    },
    async (args) => {
      try {
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

        const buffer = Buffer.from(await resp.arrayBuffer());

        // Determine filename
        let name = args.filename;
        if (!name) {
          const urlPath = new URL(args.url).pathname;
          const segments = urlPath.split('/');
          name = segments[segments.length - 1] || 'download';
          name = decodeURIComponent(name);
        }
        const safeFilename = name.replace(/[^a-zA-Z0-9._-]/g, '_');

        // Save to persistent company folder
        if (args.save_dir) {
          mkdirSync(args.save_dir, { recursive: true });
          writeFileSync(path.join(args.save_dir, safeFilename), buffer);
          log(`Saved to ${args.save_dir}/${safeFilename} (${buffer.length} bytes)`);
        }

        // Auto-send to chat via IPC
        let sent = false;
        if (IPC_CHAT_JID && IPC_GROUP_FOLDER) {
          const ipcFilesDir = '/workspace/ipc/files';
          mkdirSync(ipcFilesDir, { recursive: true });
          const ipcFilePath = path.join(ipcFilesDir, `${Date.now()}-${safeFilename}`);
          writeFileSync(ipcFilePath, buffer);

          const ipcMsgDir = '/workspace/ipc/messages';
          mkdirSync(ipcMsgDir, { recursive: true });
          const msgFilename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
          const tmpPath = path.join(ipcMsgDir, `${msgFilename}.tmp`);
          writeFileSync(tmpPath, JSON.stringify({
            type: 'file',
            chatJid: IPC_CHAT_JID,
            filePath: ipcFilePath,
            filename: name,
            groupFolder: IPC_GROUP_FOLDER,
            timestamp: new Date().toISOString(),
          }, null, 2));
          renameSync(tmpPath, path.join(ipcMsgDir, msgFilename));
          log(`IPC file send queued: ${name}`);
          sent = true;
        }

        const savedTo = args.save_dir ? `${args.save_dir}/${safeFilename}` : '(temp only)';
        return {
          content: [
            {
              type: 'text' as const,
              text: `Downloaded "${name}" (${buffer.length} bytes). Saved to ${savedTo}.${sent ? ' Sent to chat.' : ' WARNING: Could not auto-send.'}`,
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
