import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

function writeTokenFile(token: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'granola-mcp-'));
  const tokenPath = join(dir, 'granola-token.json');
  writeFileSync(tokenPath, JSON.stringify(token, null, 2));
  return tokenPath;
}

describe('granola MCP token handling', () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
    delete process.env.GRANOLA_TOKEN_PATH;

    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it('refreshes expired access tokens and persists the new token', async () => {
    const tokenPath = writeTokenFile({
      access_token: 'expired-access',
      refresh_token: 'refresh-123',
    });
    tempDirs.push(dirname(tokenPath));
    process.env.GRANOLA_TOKEN_PATH = tokenPath;

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'fresh-access' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          'data: {"result":{"content":[{"type":"text","text":"meeting notes"}]}}\n',
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { callGranolaTool } = await import(
      '../container/mcp-servers/granola/src/granola-client.js'
    );
    const result = await callGranolaTool('query_granola_meetings', {
      query: 'What happened?',
    });

    expect(result).toBe('meeting notes');
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const firstRequest = fetchMock.mock.calls[0];
    expect(firstRequest?.[0]).toBe('https://mcp.granola.ai/mcp');
    expect((firstRequest?.[1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer expired-access',
    });

    const refreshRequest = fetchMock.mock.calls[1];
    expect(refreshRequest?.[0]).toBe('https://mcp-auth.granola.ai/oauth2/token');
    expect(String((refreshRequest?.[1] as RequestInit).body)).toContain(
      'refresh_token=refresh-123',
    );

    const retryRequest = fetchMock.mock.calls[2];
    expect((retryRequest?.[1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer fresh-access',
    });

    const savedToken = JSON.parse(readFileSync(tokenPath, 'utf-8')) as {
      access_token?: string;
      refresh_token?: string;
    };
    expect(savedToken.access_token).toBe('fresh-access');
    expect(savedToken.refresh_token).toBe('refresh-123');
  });

  it('re-reads the token file on each call instead of caching the access token', async () => {
    const tokenPath = writeTokenFile({
      access_token: 'access-a',
      refresh_token: 'refresh-123',
    });
    tempDirs.push(dirname(tokenPath));
    process.env.GRANOLA_TOKEN_PATH = tokenPath;

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          'data: {"result":{"content":[{"type":"text","text":"first call"}]}}\n',
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          'data: {"result":{"content":[{"type":"text","text":"second call"}]}}\n',
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { callGranolaTool } = await import(
      '../container/mcp-servers/granola/src/granola-client.js'
    );

    const firstResult = await callGranolaTool('list_meetings', {
      time_range: 'last_30_days',
    });
    expect(firstResult).toBe('first call');
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer access-a',
    });

    writeFileSync(
      tokenPath,
      JSON.stringify(
        {
          access_token: 'access-b',
          refresh_token: 'refresh-123',
        },
        null,
        2,
      ),
    );

    const secondResult = await callGranolaTool('list_meetings', {
      time_range: 'last_30_days',
    });
    expect(secondResult).toBe('second call');
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer access-b',
    });
  });
});
