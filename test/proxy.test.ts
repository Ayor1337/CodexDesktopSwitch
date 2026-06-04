import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getProxyStatus, startProxy, stopProxy } from '../electron/main/proxy';

interface MockUpstream {
  url: string;
  lastRequest: { method: string; path: string; body: unknown; auth: string | null } | null;
  close: () => Promise<void>;
}

function startUpstream(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): Promise<MockUpstream> {
  return new Promise((resolve) => {
    const state: MockUpstream = {
      url: '',
      lastRequest: null,
      close: () => Promise.resolve()
    };
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = body;
        try {
          parsed = body ? JSON.parse(body) : '';
        } catch {
          /* keep raw */
        }
        state.lastRequest = {
          method: req.method ?? '',
          path: req.url ?? '',
          body: parsed,
          auth: req.headers.authorization ?? null
        };
        handler(req, res, body);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      state.url = `http://127.0.0.1:${port}`;
      state.close = () =>
        new Promise<void>((r) => {
          server.close(() => r());
          server.closeAllConnections?.();
        });
      resolve(state);
    });
  });
}

async function postJson(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  return { status: res.status, json };
}

async function postStream(url: string, body: unknown): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body)
  });
  expect(res.body).toBeTruthy();
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value);
  }
  return out;
}

let upstream: MockUpstream | null = null;

beforeEach(() => {
  upstream = null;
});

afterEach(async () => {
  await stopProxy();
  if (upstream) await upstream.close();
});

describe('proxy server', () => {
  it('translates a non-streaming Responses request to Chat Completions and back', async () => {
    upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'cmpl_1',
          object: 'chat.completion',
          created: 42,
          model: 'gpt-x',
          choices: [{ message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
        })
      );
    });

    const { port } = await startProxy({
      upstreamBaseUrl: `${upstream.url}/v1`,
      apiKey: 'secret-key',
      profileName: 'p1'
    });
    expect(getProxyStatus()).toMatchObject({ running: true, port, profileName: 'p1' });

    const { status, json } = await postJson(`http://127.0.0.1:${port}/v1/responses`, {
      model: 'gpt-x',
      input: 'ping',
      instructions: 'be brief'
    });

    expect(status).toBe(200);
    expect(upstream.lastRequest?.method).toBe('POST');
    expect(upstream.lastRequest?.path).toBe('/v1/chat/completions');
    expect(upstream.lastRequest?.auth).toBe('Bearer secret-key');
    const upstreamBody = upstream.lastRequest?.body as { messages: unknown[] };
    expect(upstreamBody.messages[0]).toEqual({ role: 'system', content: 'be brief' });
    expect(upstreamBody.messages[1]).toEqual({ role: 'user', content: 'ping' });

    const resp = json as { output: Array<{ content: Array<{ text: string }> }> };
    expect(resp.output[0].content[0].text).toBe('pong');
  });

  it('streams a chat completions SSE through as Responses events', async () => {
    upstream = await startUpstream((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      res.write(`data: {"id":"r","model":"m","created":1,"choices":[{"delta":{"content":"hi"}}]}\n\n`);
      res.write(`data: {"id":"r","model":"m","choices":[{"delta":{"content":"!"}}]}\n\n`);
      res.write(`data: [DONE]\n\n`);
      res.end();
    });

    const { port } = await startProxy({
      upstreamBaseUrl: `${upstream.url}/v1`,
      apiKey: 'k',
      profileName: 'p'
    });

    const stream = await postStream(`http://127.0.0.1:${port}/v1/responses`, {
      model: 'm',
      input: 'hi',
      stream: true
    });

    expect(stream).toContain('event: response.created');
    expect(stream).toContain('event: response.output_text.delta');
    expect(stream).toContain('event: response.completed');
    expect(stream.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('wraps upstream errors and preserves the status code', async () => {
    upstream = await startUpstream((_req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
    });

    const { port } = await startProxy({
      upstreamBaseUrl: `${upstream.url}/v1`,
      apiKey: 'k',
      profileName: 'p'
    });
    const { status, json } = await postJson(`http://127.0.0.1:${port}/v1/responses`, {
      model: 'm',
      input: 'x'
    });
    expect(status).toBe(429);
    const err = (json as { error?: { type?: string; message?: string } }).error;
    expect(err?.type).toBe('upstream_error');
    expect(err?.message).toBe('rate limited');
  });

  it('stops the previous server when restarted on a new port', async () => {
    upstream = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end('{}');
    });
    const first = await startProxy({ upstreamBaseUrl: `${upstream.url}/v1`, apiKey: 'k', profileName: 'a' });
    const second = await startProxy({ upstreamBaseUrl: `${upstream.url}/v1`, apiKey: 'k', profileName: 'b' });
    expect(getProxyStatus().profileName).toBe('b');
    // Old port should no longer accept connections.
    await expect(
      fetch(`http://127.0.0.1:${first.port}/v1/responses`, { method: 'POST' })
    ).rejects.toThrow();
    expect(second.port).not.toBe(first.port);
  });

  it('stopProxy leaves status idle', async () => {
    upstream = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end('{}');
    });
    await startProxy({ upstreamBaseUrl: `${upstream.url}/v1`, apiKey: 'k', profileName: 'p' });
    await stopProxy();
    expect(getProxyStatus()).toEqual({ running: false, port: null, profileName: null });
  });
});
