// app.ts — the forge's HTTP server: one process, one in-memory Store, four
// surfaces on one port.
//
// Routing:
//   GET  /healthz            200 {"ok":true}, no auth (the env's liveness probe)
//   /:owner/:repo.git/*      git smart HTTP (info/refs, upload-pack, receive-pack)
//                            — unauthenticated, like the git wire the checks use
//   /api/v3/*                REST v3 (auth required)
//   /api/graphql             GraphQL v4 (auth required)
//   /mcp                     MCP over streamable HTTP (auth required)
//   anything else            JSON 404 {"message":"Not Found"}
//
// Every reply carries X-GitHub-Request-Id and is application/json (except the
// git wire's own content types). A missing or wrong bearer token on an API
// route is a 401. A malformed JSON body on a REST or GraphQL route is a 400;
// on /mcp the MCP handler answers -32700 itself, so the body is passed through.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './git.ts';
import { handleGraphql } from './graphql.ts';
import { makeReply, newRequestId, readBody, tokenValid, type Ctx } from './http.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

/** Whether this path is a JSON API route (its body is parsed as JSON). */
function isJsonRoute(path: string): boolean {
  return path.startsWith('/api/v3') || path === '/api/graphql' || path === '/mcp';
}

/** Whether this path needs the bearer token. */
function needsAuth(path: string): boolean {
  return path.startsWith('/api/v3') || path === '/api/graphql' || path === '/mcp';
}

/** Build the server. One Store lives for the process's whole life. */
export function createApp(): Server {
  const store = new Store();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = newRequestId();
      const reply = makeReply(res, requestId);
      // One URL parse per request (path + query), not two.
      let path = '/';
      let query = new URLSearchParams();
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        path = url.pathname;
        query = url.searchParams;
      } catch {
        // Keep the defaults: an unparseable URL is a 404 below.
      }
      const method = req.method ?? 'GET';
      // A bodyless request (GET/HEAD, or no content-length) needs no stream wait;
      // a request that does carry a body is always read, so keep-alive stays framed.
      const contentLength = req.headers['content-length'];
      const hasBody = contentLength !== undefined && contentLength !== '0' && contentLength !== '';
      const body = hasBody || (method !== 'GET' && method !== 'HEAD') ? await readBody(req) : Buffer.alloc(0);
      let json: unknown;
      let jsonError = false;
      if (isJsonRoute(path) && body.length > 0) {
        try {
          json = JSON.parse(body.toString('utf8')) as unknown;
        } catch {
          jsonError = true;
        }
      }
      const ctx: Ctx = {
        method,
        path,
        query,
        headers: req.headers,
        body,
        json,
        jsonError,
        requestId,
        host: req.headers.host ?? 'localhost',
        req,
        res,
      };
      try {
        // Liveness probe, no auth.
        if (method === 'GET' && path === '/healthz') {
          reply.json(200, { ok: true });
          return;
        }
        // Git smart HTTP is unauthenticated and its bodies are binary packs.
        if (handleGit(ctx, store, (status, payload, contentType, extra) => reply.raw(status, payload, contentType, extra), (status, payload, extra) => reply.json(status, payload, extra))) {
          return;
        }
        // Every API route needs the trial token.
        if (needsAuth(path) && !tokenValid(ctx)) {
          reply.json(401, { message: 'Requires authentication' });
          return;
        }
        // A malformed JSON body is a 400 on REST and GraphQL; /mcp answers
        // -32700 itself, so its handler sees the flag instead.
        if (jsonError && (path.startsWith('/api/v3') || path === '/api/graphql')) {
          reply.json(400, { message: 'Malformed JSON in request body' });
          return;
        }
        if (handleRest(ctx, store, reply)) return;
        if (handleGraphql(ctx, store, reply)) return;
        if (handleMcp(ctx, store, reply)) return;
        reply.json(404, { message: 'Not Found' });
      } catch (err) {
        // A handler must never crash the server: the repo-survives-errors
        // contract holds for every surface, including a malformed request.
        if (!res.headersSent) {
          reply.json(500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          try {
            res.end();
          } catch {
            // The response is already gone; nothing left to do.
          }
        }
      }
    })();
  });
  return server;
}
