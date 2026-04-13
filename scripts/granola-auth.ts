/**
 * One-time Granola OAuth authorization for NanoClaw.
 * Authorizes access to Granola meeting notes via MCP.
 * Uses OAuth 2.0 Authorization Code flow with PKCE.
 *
 * Usage:
 *   npx tsx scripts/granola-auth.ts \
 *     --token groups/slack_main/reference/granola-token.json
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createServer } from 'http';
import { URL } from 'url';
import { resolve } from 'path';
import { randomBytes, createHash } from 'crypto';

const GRANOLA_CLIENT_ID = 'client_01KP4EWQ9GPWCXHMGZKGGJ9QM2';
const AUTH_URL = 'https://mcp-auth.granola.ai/oauth2/authorize';
const TOKEN_URL = 'https://mcp-auth.granola.ai/oauth2/token';
const REDIRECT_PORT = 3334;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;
const SCOPES = 'openid email profile offline_access';

function parseArgs(): { token: string } {
  const args = process.argv.slice(2);
  let token = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--token' && args[i + 1]) {
      token = resolve(args[++i]);
    }
  }

  if (!token) {
    token = resolve('groups/slack_main/reference/granola-token.json');
  }

  return { token };
}

function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function refreshToken(tokenPath: string): Promise<boolean> {
  const token = JSON.parse(readFileSync(tokenPath, 'utf-8'));
  if (!token.refresh_token) return false;

  try {
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: GRANOLA_CLIENT_ID,
        refresh_token: token.refresh_token,
      }),
    });

    if (!resp.ok) return false;

    const newToken = await resp.json();
    const merged = { ...token, ...newToken };
    writeFileSync(tokenPath, JSON.stringify(merged, null, 2));
    console.log('Token refreshed successfully.');
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const { token: tokenPath } = parseArgs();

  console.log('=== NanoClaw Granola Authorization ===\n');

  // Check for existing token
  if (existsSync(tokenPath)) {
    console.log(`Existing token found at ${tokenPath}`);
    const token = JSON.parse(readFileSync(tokenPath, 'utf-8'));

    // Try to use it
    const testResp = await fetch('https://mcp.granola.ai/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
        id: 1,
      }),
    });

    if (testResp.ok) {
      console.log('Token is valid. Granola access confirmed.');
      console.log('\n=== Authorization OK ===');
      return;
    }

    // Try refresh
    console.log('Access token expired, attempting refresh...');
    if (await refreshToken(tokenPath)) {
      console.log('\n=== Authorization OK ===');
      return;
    }

    console.log('Refresh failed. Re-authorizing...\n');
  }

  // New authorization flow with PKCE
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = randomBytes(16).toString('hex');

  const authParams = new URLSearchParams({
    response_type: 'code',
    client_id: GRANOLA_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  const authUrl = `${AUTH_URL}?${authParams}`;

  console.log('Opening browser for Granola authorization...');
  const open = (await import('open')).default;
  await open(authUrl);

  console.log('If browser does not open, visit this URL:\n');
  console.log(authUrl);
  console.log();

  // Start local server to receive callback
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${REDIRECT_PORT}`);
      const error = url.searchParams.get('error');
      const returnedState = url.searchParams.get('state');
      const authCode = url.searchParams.get('code');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h1>Authorization failed</h1><p>${error}</p>`);
        server.close();
        reject(new Error(`Authorization failed: ${error}`));
        return;
      }

      if (returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>State mismatch</h1>');
        server.close();
        reject(new Error('State mismatch'));
        return;
      }

      if (authCode) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<h1>Authorization successful!</h1>' +
            '<p>You can close this tab and return to the terminal.</p>',
        );
        server.close();
        resolve(authCode);
      }
    });
    server.listen(REDIRECT_PORT, () => {
      console.log(
        `Waiting for authorization callback on port ${REDIRECT_PORT}...\n`,
      );
    });
  });

  // Exchange code for token
  const tokenResp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: GRANOLA_CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
    }),
  });

  if (!tokenResp.ok) {
    const err = await tokenResp.text();
    console.error(`Token exchange failed: ${err}`);
    process.exit(1);
  }

  const tokens = await tokenResp.json();

  if (!tokens.refresh_token) {
    console.warn(
      'WARNING: No refresh_token received. Token will expire and need re-auth.',
    );
  }

  writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  console.log(`Token saved to ${tokenPath}\n`);

  // Verify access
  const verifyResp = await fetch('https://mcp.granola.ai/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokens.access_token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/list',
      id: 2,
    }),
  });

  if (verifyResp.ok) {
    const data = (await verifyResp.json()) as {
      result?: { tools?: Array<{ name: string }> };
    };
    const toolNames =
      data.result?.tools?.map((t) => t.name).join(', ') || 'none';
    console.log(`Granola access confirmed. Available tools: ${toolNames}`);
  } else {
    console.log('Token saved but verification call returned non-200.');
  }

  console.log('\n=== Authorization complete ===');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
