// Entry point: connect the forge to the make.fun trial environment.
//
// The environment owns the trial. This process has one job: start the
// server, hand the environment the port it picked, and stay alive until
// the environment says the trial is over. The server itself lives in
// app.ts; this file only runs the handshake around it.
//
// The handshake, step by step:
//   - MAKEFUN_ENV_URL names the environment's origin. Without it there
//     is nothing to talk to, so the process gives up at once.
//   - The server listens on port 0 and the kernel picks a free one. The
//     environment owns 8080, so a fixed port is never used.
//   - POST /register tells the environment the bound port. The first
//     registration wins: a 409 means another entry registered first and
//     this process simply waits like any other.
//   - GET /done is polled until the environment answers {"done": true}.
//     A poll that fails or times out is retried with backoff; the
//     process never leaves before the environment says done.
//   - The server closes and the process exits 0.

import { createApp } from './app.ts';

/** One HTTP round trip may take this long before it is abandoned and retried. */
const HTTP_TIMEOUT_MS = 30_000;

/** Backoff between retries: start here, double each time, never pass the cap. */
const BACKOFF_FIRST_MS = 250;
const BACKOFF_CEILING_MS = 2_000;
/** The doubling stops growing the delay after this many failures. */
const BACKOFF_MAX_STEPS = 8;

/** The environment's origin, trailing slashes removed. Exits 1 when unset. */
function envOrigin(): string {
  const raw = process.env.MAKEFUN_ENV_URL ?? '';
  const origin = raw.replace(/\/+$/, '');
  if (origin === '') {
    process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
    process.exit(1);
  }
  return origin;
}

/** Grows the wait after each failed attempt: 250 ms, 500 ms, … up to 2 s. */
class Backoff {
  private failures = 0;

  async wait(): Promise<void> {
    const steps = Math.min(this.failures, BACKOFF_MAX_STEPS);
    const delay = Math.min(BACKOFF_CEILING_MS, BACKOFF_FIRST_MS * 2 ** steps);
    this.failures += 1;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/**
 * POST the bound port until the environment accepts it. 200 is the normal
 * answer; 409 means another entry registered first, which is not this
 * process's problem. 400 and 405 are contract errors and end the program;
 * anything else (network down, timeout, another status) is retried, since
 * the environment may still be starting.
 */
async function announcePort(origin: string, port: number): Promise<void> {
  const backoff = new Backoff();
  for (;;) {
    try {
      const response = await fetch(`${origin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('register answered HTTP ')) throw error;
    }
    await backoff.wait();
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function awaitTrialEnd(origin: string): Promise<void> {
  const backoff = new Backoff();
  for (;;) {
    try {
      const response = await fetch(`${origin}/done`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // The environment is not answering yet, or the poll timed out: not done, poll again.
    }
    await backoff.wait();
  }
}

/** Start the forge on a kernel-chosen port and report the port it bound. */
async function startServer() {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  return { server, port: bound.port };
}

/** Bind the port, register it, then wait for the environment: the whole life of the process. */
async function run(): Promise<void> {
  const origin = envOrigin();
  const { server, port } = await startServer();
  process.stdout.write(`[entry] listening on port ${port}\n`);

  await announcePort(origin, port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitTrialEnd(origin);
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
} catch (failure) {
  const message = failure instanceof Error ? failure.message : String(failure);
  process.stderr.write(`[entry] ${message}\n`);
  process.exit(1);
}
process.exit(0);
