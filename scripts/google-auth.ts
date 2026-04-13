/**
 * One-time Google OAuth authorization for NanoClaw.
 * Authorizes Calendar (read-only) and Gmail (read-only) access.
 * Saves a refresh token that persists indefinitely for Internal Workspace apps.
 *
 * Usage:
 *   npx tsx scripts/google-auth.ts \
 *     --credentials groups/slack_main/reference/google-credentials.json \
 *     --token groups/slack_main/reference/google-token.json
 */

import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createServer } from 'http';
import { URL } from 'url';
import { resolve } from 'path';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
];
const REDIRECT_PORT = 3333;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;

function parseArgs(): { credentials: string; token: string } {
  const args = process.argv.slice(2);
  let credentials = '';
  let token = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--credentials' && args[i + 1]) {
      credentials = resolve(args[++i]);
    } else if (args[i] === '--token' && args[i + 1]) {
      token = resolve(args[++i]);
    }
  }

  if (!credentials) {
    credentials = resolve('groups/slack_main/reference/google-credentials.json');
  }
  if (!token) {
    token = resolve('groups/slack_main/reference/google-token.json');
  }

  return { credentials, token };
}

async function main(): Promise<void> {
  const { credentials: credPath, token: tokenPath } = parseArgs();

  console.log('=== NanoClaw Google Authorization ===\n');

  if (!existsSync(credPath)) {
    console.error(`Credentials file not found: ${credPath}`);
    console.error('Download OAuth credentials from Google Cloud Console → Credentials');
    process.exit(1);
  }

  // Check for existing token
  if (existsSync(tokenPath)) {
    console.log(`Existing token found at ${tokenPath}`);
    console.log('To re-authorize, delete the token file and run this script again.\n');

    // Verify the token still works
    const creds = JSON.parse(readFileSync(credPath, 'utf-8'));
    const { client_id, client_secret } = creds.installed || creds.web;
    const oauth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);
    const token = JSON.parse(readFileSync(tokenPath, 'utf-8'));
    oauth2Client.setCredentials(token);

    try {
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
      const result = await calendar.calendarList.list({ maxResults: 1 });
      console.log(`Token is valid. Calendar access confirmed (${result.data.items?.length || 0}+ calendars).`);

      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
      const profile = await gmail.users.getProfile({ userId: 'me' });
      console.log(`Gmail access confirmed (${profile.data.emailAddress}).`);
      console.log('\n=== Authorization OK ===');
    } catch (err) {
      console.error(`Token verification failed: ${err instanceof Error ? err.message : String(err)}`);
      console.error('Delete the token file and re-run this script to re-authorize.');
    }
    return;
  }

  // New authorization flow
  const creds = JSON.parse(readFileSync(credPath, 'utf-8'));
  const { client_id, client_secret } = creds.installed || creds.web;
  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // Force consent to ensure refresh_token is returned
  });

  console.log('Scopes requested:');
  console.log('  - Google Calendar (read-only)');
  console.log('  - Gmail (read-only)\n');

  // Open browser
  console.log('Opening browser for authorization...');
  const open = (await import('open')).default;
  await open(authUrl);

  console.log('If browser does not open, visit this URL:\n');
  console.log(authUrl);
  console.log();

  // Start local server to receive callback
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${REDIRECT_PORT}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h1>Authorization failed</h1><p>${error}</p>`);
        server.close();
        reject(new Error(`Authorization failed: ${error}`));
        return;
      }
      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<h1>Authorization successful!</h1>' +
          '<p>You can close this tab and return to the terminal.</p>'
        );
        server.close();
        resolve(code);
      } else {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>No authorization code received</h1>');
      }
    });
    server.listen(REDIRECT_PORT, () => {
      console.log(`Waiting for authorization callback on port ${REDIRECT_PORT}...\n`);
    });
  });

  // Exchange code for token
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  if (!tokens.refresh_token) {
    console.warn('WARNING: No refresh_token received. The token will expire.');
    console.warn('This can happen if the app was previously authorized.');
    console.warn('Go to https://myaccount.google.com/permissions, revoke access, then re-run.\n');
  }

  // Save token
  writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  console.log(`Token saved to ${tokenPath}\n`);

  // Verify access
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  const calResult = await calendar.calendarList.list();
  console.log(`Calendar access: ${calResult.data.items?.length || 0} calendars found`);

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  console.log(`Gmail access: ${profile.data.emailAddress}`);

  console.log('\n=== Authorization complete ===');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
