import { readFileSync, renameSync, writeFileSync } from 'fs';

const GRANOLA_TOKEN_PATH = process.env.GRANOLA_TOKEN_PATH || '';
const GRANOLA_CLIENT_ID = 'client_01KP4EWQ9GPWCXHMGZKGGJ9QM2';
const GRANOLA_TOKEN_URL = 'https://mcp-auth.granola.ai/oauth2/token';

interface GranolaToken {
  access_token?: string;
  refresh_token?: string;
  [key: string]: unknown;
}

function log(msg: string): void {
  process.stderr.write(`[granola-mcp] ${msg}\n`);
}

let refreshInFlight: Promise<GranolaToken> | null = null;

function loadGranolaToken(): GranolaToken {
  try {
    return JSON.parse(readFileSync(GRANOLA_TOKEN_PATH, 'utf-8')) as GranolaToken;
  } catch {
    return {};
  }
}

function saveGranolaToken(token: GranolaToken): void {
  const nextToken = JSON.stringify(token, null, 2);
  const tempPath = `${GRANOLA_TOKEN_PATH}.tmp`;
  writeFileSync(tempPath, nextToken);
  renameSync(tempPath, GRANOLA_TOKEN_PATH);
}

async function refreshGranolaToken(): Promise<GranolaToken> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const token = loadGranolaToken();
    if (!token.refresh_token) {
      throw new Error(
        'Granola token expired and no refresh token is available. Re-run: npx tsx scripts/granola-auth.ts',
      );
    }

    const resp = await fetch(GRANOLA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: GRANOLA_CLIENT_ID,
        refresh_token: token.refresh_token,
      }),
    });

    if (!resp.ok) {
      throw new Error(
        'Granola token refresh failed. Re-run: npx tsx scripts/granola-auth.ts',
      );
    }

    const refreshed = (await resp.json()) as GranolaToken;
    const merged = { ...token, ...refreshed };
    if (!merged.access_token) {
      throw new Error(
        'Granola token refresh returned no access token. Re-run: npx tsx scripts/granola-auth.ts',
      );
    }

    saveGranolaToken(merged);
    return merged;
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

async function getGranolaAccessToken(): Promise<string> {
  const token = loadGranolaToken();
  if (token.access_token) return token.access_token;
  if (token.refresh_token) {
    const refreshed = await refreshGranolaToken();
    if (refreshed.access_token) return refreshed.access_token;
  }
  throw new Error(
    'No Granola access token. Re-run: npx tsx scripts/granola-auth.ts',
  );
}

async function postGranolaToolCall(
  accessToken: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Response> {
  const body = {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: toolName, arguments: args },
    id: Date.now(),
  };

  return fetch('https://mcp.granola.ai/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
}

export async function callGranolaTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  let accessToken = await getGranolaAccessToken();
  let resp = await postGranolaToolCall(accessToken, toolName, args);

  if (resp.status === 401) {
    log('Granola access token expired; refreshing and retrying once');
    const refreshed = await refreshGranolaToken();
    accessToken = refreshed.access_token || '';
    if (!accessToken) {
      throw new Error(
        'Granola token refresh returned no access token. Re-run: npx tsx scripts/granola-auth.ts',
      );
    }
    resp = await postGranolaToolCall(accessToken, toolName, args);
    if (resp.status === 401) {
      throw new Error(
        'Granola token refresh did not restore access. Re-run: npx tsx scripts/granola-auth.ts',
      );
    }
  }

  if (!resp.ok) {
    const errorBody = await resp.text();
    throw new Error(
      `Granola request failed (${resp.status}): ${errorBody || resp.statusText}`,
    );
  }

  const text = await resp.text();
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
