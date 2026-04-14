/**
 * Google Calendar + Gmail MCP Server for NanoClaw
 *
 * Provides read-only access to Google Calendar and Gmail via stdio MCP protocol.
 * Auth: reads OAuth credentials + token from env-specified paths.
 * Token auto-refreshes via googleapis library.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { google, type calendar_v3, type gmail_v1 } from 'googleapis';
import { readFileSync, writeFileSync } from 'fs';
import { OAuth2Client } from 'google-auth-library';

const CREDENTIALS_PATH = process.env.GOOGLE_CREDENTIALS_PATH || '';
const TOKEN_PATH = process.env.GOOGLE_TOKEN_PATH || '';

function log(msg: string): void {
  process.stderr.write(`[google-mcp] ${msg}\n`);
}

function initAuth(): OAuth2Client {
  if (!CREDENTIALS_PATH || !TOKEN_PATH) {
    throw new Error(
      'Missing GOOGLE_CREDENTIALS_PATH or GOOGLE_TOKEN_PATH environment variables',
    );
  }

  const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'));
  const { client_id, client_secret } = creds.installed || creds.web;

  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    'http://localhost:3333/oauth2callback',
  );

  const token = JSON.parse(readFileSync(TOKEN_PATH, 'utf-8'));
  oauth2Client.setCredentials(token);

  // Persist refreshed tokens
  oauth2Client.on('tokens', (newTokens) => {
    log('Token refreshed, saving...');
    const existing = JSON.parse(readFileSync(TOKEN_PATH, 'utf-8'));
    const merged = { ...existing, ...newTokens };
    writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
  });

  return oauth2Client;
}

// --- Helpers ---

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

function formatEvent(event: calendar_v3.Schema$Event): string {
  const lines: string[] = [];
  const start = event.start?.dateTime || event.start?.date || 'unknown';
  const end = event.end?.dateTime || event.end?.date || '';
  const status = event.status || 'confirmed';

  lines.push(`Title: ${event.summary || '(no title)'}`);
  lines.push(`Event ID: ${event.id}`);
  lines.push(`Start: ${start}`);
  if (end) lines.push(`End: ${end}`);
  lines.push(`Status: ${status}`);

  if (event.location) lines.push(`Location: ${event.location}`);
  if (event.hangoutLink) lines.push(`Video: ${event.hangoutLink}`);

  if (event.attendees && event.attendees.length > 0) {
    const attendeeList = event.attendees.map((a) => {
      const name = a.displayName || '';
      const email = a.email || '';
      const rsvp = a.responseStatus || 'unknown';
      const organizer = a.organizer ? ' (organizer)' : '';
      return `  - ${name ? name + ' ' : ''}<${email}> [${rsvp}]${organizer}`;
    });
    lines.push(`Attendees (${event.attendees.length}):`);
    lines.push(...attendeeList);
  }

  if (event.description) {
    const desc = event.description.length > 500
      ? event.description.slice(0, 500) + '...'
      : event.description;
    lines.push(`Description: ${stripHtml(desc)}`);
  }

  return lines.join('\n');
}

function gmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#inbox/${threadId}`;
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

function extractBody(payload: gmail_v1.Schema$MessagePart): string {
  // Try direct body
  if (payload.body?.data) {
    const decoded = decodeBase64Url(payload.body.data);
    if (payload.mimeType === 'text/plain') return decoded;
    if (payload.mimeType === 'text/html') return stripHtml(decoded);
  }

  // Try parts (multipart messages)
  if (payload.parts) {
    // Prefer text/plain
    const plainPart = payload.parts.find((p) => p.mimeType === 'text/plain');
    if (plainPart?.body?.data) {
      return decodeBase64Url(plainPart.body.data);
    }
    // Fall back to text/html
    const htmlPart = payload.parts.find((p) => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) {
      return stripHtml(decodeBase64Url(htmlPart.body.data));
    }
    // Recurse into nested multipart
    for (const part of payload.parts) {
      const body = extractBody(part);
      if (body) return body;
    }
  }

  return '';
}

interface AttachmentInfo {
  filename: string;
  attachmentId: string;
  mimeType: string;
  size: number;
}

function extractAttachments(
  payload: gmail_v1.Schema$MessagePart,
): AttachmentInfo[] {
  const attachments: AttachmentInfo[] = [];

  if (payload.filename && payload.filename.length > 0 && payload.body?.attachmentId) {
    attachments.push({
      filename: payload.filename,
      attachmentId: payload.body.attachmentId,
      mimeType: payload.mimeType || 'application/octet-stream',
      size: payload.body.size || 0,
    });
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      attachments.push(...extractAttachments(part));
    }
  }

  return attachments;
}

function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
}

// --- Main ---

async function main(): Promise<void> {
  const auth = initAuth();
  const calendar = google.calendar({ version: 'v3', auth });
  const gmail = google.gmail({ version: 'v1', auth });

  const server = new McpServer({
    name: 'google',
    version: '1.0.0',
  });

  // ============ CALENDAR TOOLS ============

  server.tool(
    'list_calendars',
    'List all Google Calendars the user has access to, including shared team calendars',
    {},
    async () => {
      try {
        const result = await calendar.calendarList.list({ maxResults: 100 });
        const items = result.data.items || [];
        const lines = items.map((cal) => {
          const access = cal.accessRole || 'unknown';
          const primary = cal.primary ? ' (PRIMARY)' : '';
          return `[${access}] ${cal.summary}${primary} — ID: ${cal.id}`;
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Found ${items.length} calendars:\n\n${lines.join('\n')}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error listing calendars: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'list_events',
    'List upcoming events from a Google Calendar within a time range. Defaults to today if no time range specified.',
    {
      calendar_id: z
        .string()
        .default('primary')
        .describe(
          'Calendar ID. Use "primary" for the user\'s main calendar, or a specific calendar ID from list_calendars.',
        ),
      time_min: z
        .string()
        .optional()
        .describe(
          'Start of time range (RFC3339, e.g. "2026-04-13T00:00:00-07:00"). Defaults to now.',
        ),
      time_max: z
        .string()
        .optional()
        .describe(
          'End of time range (RFC3339, e.g. "2026-04-14T00:00:00-07:00"). Defaults to end of today.',
        ),
      max_results: z
        .number()
        .int()
        .default(20)
        .describe('Maximum number of events to return (default 20, max 50)'),
    },
    async (args) => {
      try {
        const now = new Date();
        const endOfDay = new Date(now);
        endOfDay.setHours(23, 59, 59, 999);

        const result = await calendar.events.list({
          calendarId: args.calendar_id,
          timeMin: args.time_min || now.toISOString(),
          timeMax: args.time_max || endOfDay.toISOString(),
          maxResults: Math.min(args.max_results, 50),
          singleEvents: true,
          orderBy: 'startTime',
        });

        const items = result.data.items || [];
        if (items.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'No events found in the specified time range.',
              },
            ],
          };
        }

        const formatted = items.map(formatEvent).join('\n\n---\n\n');
        return {
          content: [
            {
              type: 'text' as const,
              text: `Found ${items.length} events:\n\n${formatted}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error listing events: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'get_event',
    'Get full details of a specific calendar event by its event ID',
    {
      event_id: z.string().describe('The event ID'),
      calendar_id: z
        .string()
        .default('primary')
        .describe('Calendar ID (default: primary)'),
    },
    async (args) => {
      try {
        const result = await calendar.events.get({
          calendarId: args.calendar_id,
          eventId: args.event_id,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: formatEvent(result.data),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error getting event: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ============ GMAIL TOOLS ============

  server.tool(
    'search_threads',
    'Search Gmail threads by email address and/or person name. Constructs a union query so matches work even when people use different email addresses. Returns thread ID, subject, snippet, date, and a direct Gmail link.',
    {
      email: z
        .string()
        .optional()
        .describe('Email address to search for (e.g. "jane@dioxycle.com")'),
      name: z
        .string()
        .optional()
        .describe(
          'Person name to search for (e.g. "Jane Smith"). Used as a fallback when email alone returns no results.',
        ),
      query: z
        .string()
        .optional()
        .describe(
          'Additional Gmail query filters (e.g. "after:2026/03/01", "subject:quarterly update", "has:attachment"). Combined with email/name search.',
        ),
      max_results: z
        .number()
        .int()
        .default(10)
        .describe('Maximum number of threads to return (default 10, max 30)'),
    },
    async (args) => {
      try {
        if (!args.email && !args.name && !args.query) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Provide at least one of: email, name, or query.',
              },
            ],
            isError: true,
          };
        }

        // Build union query for email + name
        const fromParts: string[] = [];
        if (args.email) fromParts.push(`from:${args.email}`);
        if (args.name) fromParts.push(`from:"${args.name}"`);

        let q = '';
        if (fromParts.length > 1) {
          // Gmail OR syntax: {term1 term2}
          q = `{${fromParts.join(' ')}}`;
        } else if (fromParts.length === 1) {
          q = fromParts[0];
        }

        if (args.query) {
          q = q ? `${q} ${args.query}` : args.query;
        }

        log(`Gmail search query: ${q}`);

        const result = await gmail.users.threads.list({
          userId: 'me',
          q,
          maxResults: Math.min(args.max_results, 30),
        });

        const threads = result.data.threads || [];
        if (threads.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No threads found for query: ${q}`,
              },
            ],
          };
        }

        // Fetch minimal details for each thread
        const summaries: string[] = [];
        for (const thread of threads) {
          if (!thread.id) continue;
          try {
            const detail = await gmail.users.threads.get({
              userId: 'me',
              id: thread.id,
              format: 'metadata',
              metadataHeaders: ['Subject', 'From', 'Date'],
            });

            const firstMsg = detail.data.messages?.[0];
            const headers = firstMsg?.payload?.headers;
            const subject = getHeader(headers, 'Subject') || '(no subject)';
            const from = getHeader(headers, 'From');
            const date = getHeader(headers, 'Date');
            const msgCount = detail.data.messages?.length || 0;
            const url = gmailThreadUrl(thread.id);

            summaries.push(
              `Subject: ${subject}\n` +
                `From: ${from}\n` +
                `Date: ${date}\n` +
                `Messages: ${msgCount}\n` +
                `Thread ID: ${thread.id}\n` +
                `Link: ${url}`,
            );
          } catch {
            summaries.push(`Thread ${thread.id}: (failed to fetch details)`);
          }
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `Found ${threads.length} threads for query: ${q}\n\n${summaries.join('\n\n---\n\n')}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error searching threads: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'get_thread',
    'Get full Gmail thread by ID. Returns all messages with sender, date, body text, and attachment info (filename, msgId, attId for use with download_attachment).',
    {
      thread_id: z.string().describe('The Gmail thread ID'),
    },
    async (args) => {
      try {
        const result = await gmail.users.threads.get({
          userId: 'me',
          id: args.thread_id,
          format: 'full',
        });

        const messages = result.data.messages || [];
        const url = gmailThreadUrl(args.thread_id);

        const formatted = messages.map((msg) => {
          const headers = msg.payload?.headers;
          const from = getHeader(headers, 'From');
          const to = getHeader(headers, 'To');
          const date = getHeader(headers, 'Date');
          const subject = getHeader(headers, 'Subject');

          let body = msg.payload ? extractBody(msg.payload) : '';
          if (body.length > 3000) {
            body = body.slice(0, 3000) + '\n... (truncated)';
          }

          const attachments = msg.payload
            ? extractAttachments(msg.payload)
            : [];
          const attachLine =
            attachments.length > 0
              ? `Attachments: ${attachments.map((a) => `${a.filename} (msgId=${msg.id}, attId=${a.attachmentId})`).join(', ')}`
              : '';

          return [
            `From: ${from}`,
            `To: ${to}`,
            `Date: ${date}`,
            subject ? `Subject: ${subject}` : '',
            attachLine,
            '',
            body,
          ]
            .filter(Boolean)
            .join('\n');
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: `Thread: ${url}\nMessages: ${messages.length}\n\n${formatted.join('\n\n========\n\n')}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error getting thread: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'list_messages',
    'List recent Gmail messages with optional query filter',
    {
      query: z
        .string()
        .optional()
        .describe(
          'Gmail search query (e.g. "is:unread", "from:jane@example.com after:2026/04/01")',
        ),
      max_results: z
        .number()
        .int()
        .default(10)
        .describe('Maximum number of messages to return (default 10, max 30)'),
    },
    async (args) => {
      try {
        const result = await gmail.users.messages.list({
          userId: 'me',
          q: args.query || '',
          maxResults: Math.min(args.max_results, 30),
        });

        const messages = result.data.messages || [];
        if (messages.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No messages found${args.query ? ` for query: ${args.query}` : ''}.`,
              },
            ],
          };
        }

        const summaries: string[] = [];
        for (const msg of messages) {
          if (!msg.id) continue;
          try {
            const detail = await gmail.users.messages.get({
              userId: 'me',
              id: msg.id,
              format: 'metadata',
              metadataHeaders: ['Subject', 'From', 'Date'],
            });

            const headers = detail.data.payload?.headers;
            const subject = getHeader(headers, 'Subject') || '(no subject)';
            const from = getHeader(headers, 'From');
            const date = getHeader(headers, 'Date');

            summaries.push(
              `Subject: ${subject}\nFrom: ${from}\nDate: ${date}\nMessage ID: ${msg.id}\nThread ID: ${msg.threadId}`,
            );
          } catch {
            summaries.push(`Message ${msg.id}: (failed to fetch details)`);
          }
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `Found ${messages.length} messages:\n\n${summaries.join('\n\n---\n\n')}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error listing messages: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // download_attachment — fetch file content from a Gmail message attachment
  server.tool(
    'download_attachment',
    'Download a file attachment from a Gmail message. Use message_id and attachment_id from get_thread results (shown as msgId=xxx, attId=yyy). Returns base64 file content.',
    {
      message_id: z.string().describe('Gmail message ID (from get_thread results)'),
      attachment_id: z.string().describe('Attachment ID (from get_thread results)'),
    },
    async (args) => {
      try {
        // Get attachment data
        const att = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId: args.message_id,
          id: args.attachment_id,
        });

        const data = att.data.data; // base64url-encoded content
        if (!data) {
          return {
            content: [{ type: 'text' as const, text: 'Attachment has no content.' }],
            isError: true,
          };
        }

        // Get message to find the filename and mime type
        const msg = await gmail.users.messages.get({
          userId: 'me',
          id: args.message_id,
          format: 'full',
        });

        let filename = 'attachment';
        let mimeType = 'application/octet-stream';
        const parts = msg.data.payload?.parts || [];
        for (const part of parts) {
          if (part.body?.attachmentId === args.attachment_id) {
            filename = part.filename || filename;
            mimeType = part.mimeType || mimeType;
            break;
          }
        }

        // Convert base64url to standard base64
        const base64 = data.replace(/-/g, '+').replace(/_/g, '/');

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ filename, mimeType, base64, sizeBytes: base64.length }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error downloading attachment: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // Start server
  log('Starting Google MCP server...');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('Server connected');
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
