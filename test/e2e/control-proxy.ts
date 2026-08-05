import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * A controllable HTTP proxy sitting in front of the app, used by the SSE
 * resilience spec (PLAN.md §12 "SSE disconnect/reconnect").
 *
 * WHY THIS EXISTS
 * ---------------
 * §12 offers two ways to force a disconnect: Playwright request interception,
 * or "a proxy in front of the app container that can be told to drop the
 * connection". The interception route does not work for this case, and the
 * browser-level offline switch does not either — both were measured:
 *
 *   - `route.abort()` only applies while a request is being issued. Once the
 *     SSE response has begun streaming there is no handler left to abort.
 *   - `BrowserContext.setOffline(true)` does not tear down an already
 *     established streaming response. Instrumenting a raw EventSource through
 *     an offline window showed readyState stuck at 1 (OPEN), zero `error`
 *     events, and price events still arriving throughout. A test built on it
 *     passes without ever having disconnected anything, which is worse than no
 *     test at all.
 *
 * So the proxy is the only mechanism here that genuinely severs a live SSE
 * connection. The browser talks to the proxy for everything (same origin, so
 * `/api/*` and the static export both flow through it), and the test can:
 *
 *   - `dropAll()`   — destroy every open socket, killing the live SSE stream
 *   - `setRejecting(true)` — refuse new connections, so EventSource's retries
 *     actually fail for a while and its backoff is genuinely exercised
 *
 * It binds to loopback and forwards to BASE_URL, so it works unchanged whether
 * the suite runs on a developer machine or inside the Playwright container.
 */
/**
 * How the proxy should sabotage `/api/stream/prices`, leaving all other routes
 * (including the page itself) working normally.
 *
 * This distinction matters for the connection indicator's three states. A
 * dropped socket is a *transient* failure: native EventSource retries forever
 * and stays at CONNECTING, so the app shows "reconnecting" (amber) and never
 * "disconnected" (red). Red requires a *fatal* error that makes the browser
 * give up and set readyState to CLOSED — a non-200 response, or a response
 * whose Content-Type is not text/event-stream. Killing the connection can
 * therefore never produce the red state; only these faults can.
 */
export type StreamFault = 'none' | 'status' | 'content-type';

export interface ControlProxy {
  /** Base URL the browser should use instead of the app's own. */
  readonly url: string;
  /** Destroy all currently open sockets, severing any in-flight SSE stream. */
  dropAll(): void;
  /** When true, immediately destroy incoming requests instead of forwarding. */
  setRejecting(rejecting: boolean): void;
  /** Make `/api/stream/prices` fail fatally, so EventSource gives up (readyState CLOSED). */
  setStreamFault(fault: StreamFault): void;
  close(): Promise<void>;
}

export async function startControlProxy(target: string): Promise<ControlProxy> {
  const upstream = new URL(target);
  const sockets = new Set<Socket>();
  let rejecting = false;
  let streamFault: StreamFault = 'none';

  const server = http.createServer((req, res) => {
    if (rejecting) {
      res.socket?.destroy();
      return;
    }

    // Fatal stream faults: scoped to the SSE endpoint so the page and the REST
    // API keep working and the failure is unambiguously the feed's.
    if (streamFault !== 'none' && (req.url ?? '').startsWith('/api/stream/prices')) {
      if (streamFault === 'status') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"error":{"code":"internal_error","message":"simulated stream failure"}}');
      } else {
        // A 200 with the wrong Content-Type is also fatal to EventSource.
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('not an event stream');
      }
      return;
    }

    const proxyReq = http.request(
      {
        host: upstream.hostname,
        port: upstream.port || 80,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: upstream.host },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        // Pipe rather than buffer: SSE responses never end, so any buffering
        // here would stall the stream instead of relaying it.
        proxyRes.pipe(res);
      },
    );

    proxyReq.on('error', () => {
      res.socket?.destroy();
    });

    req.pipe(proxyReq);
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,

    dropAll() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },

    setRejecting(value: boolean) {
      rejecting = value;
    },

    setStreamFault(fault: StreamFault) {
      streamFault = fault;
    },

    async close() {
      rejecting = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
