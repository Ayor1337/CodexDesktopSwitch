import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProxyStatus } from '../../src/types';
import {
  chatResponseToResponses,
  chatSseToResponsesSse,
  formatSseEvent,
  responsesRequestToChat
} from './translate';

interface ProxyOptions {
  upstreamBaseUrl: string;
  apiKey: string;
  profileName: string;
}

interface RunningProxy {
  server: http.Server;
  port: number;
  options: ProxyOptions;
}

let running: RunningProxy | null = null;

function normalizeBase(url: string): string {
  return url.replace(/\/+$/, '');
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(text) as Record<string, unknown>;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache'
  });
  res.end(JSON.stringify(body));
}

function sendError(res: http.ServerResponse, status: number, message: string, code?: string): void {
  sendJson(res, status, {
    error: { type: 'proxy_error', message, code: code ?? null }
  });
}

async function* iterateChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

async function handleResponses(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: ProxyOptions
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendError(res, 400, `Invalid JSON: ${(error as Error).message}`);
    return;
  }

  const wantsStream = body.stream === true;
  const chatBody = responsesRequestToChat(body);
  chatBody.stream = wantsStream;

  const upstreamUrl = `${normalizeBase(opts.upstreamBaseUrl)}/chat/completions`;
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: wantsStream ? 'text/event-stream' : 'application/json',
        Authorization: `Bearer ${opts.apiKey}`
      },
      body: JSON.stringify(chatBody)
    });
  } catch (error) {
    sendError(res, 502, `Upstream request failed: ${(error as Error).message}`, 'upstream_unreachable');
    return;
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : text;
    } catch {
      /* keep raw text */
    }
    res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        error: {
          type: 'upstream_error',
          message: typeof parsed === 'string' ? parsed : (parsed as { error?: { message?: string } })?.error?.message ?? `Upstream returned ${upstream.status}`,
          code: String(upstream.status),
          upstream: parsed
        }
      })
    );
    return;
  }

  if (!wantsStream) {
    const json = (await upstream.json()) as Record<string, unknown>;
    sendJson(res, 200, chatResponseToResponses(json, body));
    return;
  }

  if (!upstream.body) {
    sendError(res, 502, 'Upstream stream missing body');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const aborted = () => res.writableEnded || res.destroyed;
  try {
    for await (const evt of chatSseToResponsesSse(iterateChunks(upstream.body), body)) {
      if (aborted()) break;
      res.write(formatSseEvent(evt));
    }
  } catch (error) {
    if (!aborted()) {
      res.write(
        formatSseEvent({
          event: 'response.failed',
          data: JSON.stringify({
            type: 'response.failed',
            error: { type: 'proxy_error', message: (error as Error).message }
          })
        })
      );
    }
  } finally {
    if (!aborted()) res.end();
  }
}

async function handleModels(
  res: http.ServerResponse,
  opts: ProxyOptions
): Promise<void> {
  try {
    const upstream = await fetch(`${normalizeBase(opts.upstreamBaseUrl)}/models`, {
      headers: { Authorization: `Bearer ${opts.apiKey}` }
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/json'
    });
    res.end(text);
  } catch (error) {
    sendError(res, 502, `Models pass-through failed: ${(error as Error).message}`);
  }
}

function createServer(opts: ProxyOptions): http.Server {
  return http.createServer((req, res) => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';
    if (method === 'POST' && (url === '/v1/responses' || url === '/responses')) {
      void handleResponses(req, res, opts);
      return;
    }
    if (method === 'GET' && (url === '/v1/models' || url === '/models')) {
      void handleModels(res, opts);
      return;
    }
    sendError(res, 404, `No route for ${method} ${url}`);
  });
}

export async function startProxy(opts: ProxyOptions): Promise<{ port: number }> {
  await stopProxy();
  if (!opts.upstreamBaseUrl) throw new Error('启动翻译代理失败：upstreamBaseUrl 为空');
  const server = createServer(opts);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  running = { server, port: address.port, options: opts };
  return { port: address.port };
}

export async function stopProxy(): Promise<void> {
  if (!running) return;
  const { server } = running;
  running = null;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Force-close idle connections so we don't hang on quit.
    server.closeAllConnections?.();
  });
}

export function getProxyStatus(): ProxyStatus {
  if (!running) return { running: false, port: null, profileName: null };
  return { running: true, port: running.port, profileName: running.options.profileName };
}
