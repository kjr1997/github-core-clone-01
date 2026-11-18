// http.ts — shared request context, replies and auth for the forge's HTTP layer.

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Ctx {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: Buffer;
  /** The parsed JSON body (undefined when there is no JSON body). */
  json: unknown;
  /** True when a non-empty body was sent but did not parse as JSON. */
  jsonError: boolean;
  requestId: string;
  /** The request's own host (for absolute pagination URLs). */
  host: string;
  req: IncomingMessage;
  res: ServerResponse;
}

let requestCounter = 0;

export function newRequestId(): string {
  requestCounter += 1;
  return `${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}

export interface Reply {
  json(status: number, body: unknown, extraHeaders?: Record<string, string>): void;
  raw(status: number, body: Buffer, contentType: string, extraHeaders?: Record<string, string>): void;
  empty(status: number, extraHeaders?: Record<string, string>): void;
}

export function makeReply(res: ServerResponse, requestId: string): Reply {
  const base = { 'x-github-request-id': requestId };
  return {
    json(status, body, extraHeaders = {}) {
      const text = `${JSON.stringify(body)}\n`;
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        ...base,
        ...extraHeaders,
      });
      res.end(text);
    },
    raw(status, body, contentType, extraHeaders = {}) {
      res.writeHead(status, {
        'content-type': contentType,
        'content-length': body.length,
        ...base,
        ...extraHeaders,
      });
      res.end(body);
    },
    empty(status, extraHeaders = {}) {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...base, ...extraHeaders });
      res.end();
    },
  };
}

/** The bearer token this process accepts, from the environment. */
export function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/** True when the request carries the trial token. Without a configured token any non-empty bearer passes (local runs). */
export function tokenValid(ctx: Ctx): boolean {
  const auth = ctx.headers.authorization;
  const value = Array.isArray(auth) ? auth[0] ?? '' : auth ?? '';
  const expected = expectedToken();
  if (expected !== '') return value === `Bearer ${expected}`;
  return value.startsWith('Bearer ') && value.length > 'Bearer '.length;
}

/** The path of a request URL, or '/' when it does not parse (never a throw). */
export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Read the whole request body (empty for GET/HEAD). Never throws. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}
