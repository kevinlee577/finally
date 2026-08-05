import type { FullConfig } from '@playwright/test';

/**
 * Readiness gate for the E2E suite (PLAN.md §12 "Readiness").
 *
 * Polls GET /api/health until it reports {"status": "ok"} rather than sleeping
 * a fixed amount. §8 specifies that `status` only becomes "ok" once the §7
 * startup database initialization has completed, so this also guarantees the
 * schema exists and the seed data is in place before the first scenario runs.
 *
 * docker-compose.test.yml already gates the Playwright container on the app's
 * healthcheck; this repeats the check so the suite is equally safe when run
 * from the host against a manually started container.
 */
async function globalSetup(_config: FullConfig): Promise<void> {
  const baseURL = process.env.BASE_URL ?? 'http://localhost:8000';
  const healthURL = `${baseURL}/api/health`;
  const timeoutMs = 120_000;
  const intervalMs = 1_000;
  const deadline = Date.now() + timeoutMs;

  let lastError = 'no attempt made';

  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthURL, {
        signal: AbortSignal.timeout(5_000),
      });

      if (res.ok) {
        const body = (await res.json()) as { status?: string; chat_enabled?: boolean };
        if (body.status === 'ok') {
          console.log(
            `[global-setup] App ready at ${baseURL} (chat_enabled=${body.chat_enabled}).`,
          );

          // Surface a misconfigured stack immediately rather than letting the
          // chat scenario fail later with a confusing assertion. The compose
          // file sets LLM_MOCK=true, which §8 says must make this true.
          if (body.chat_enabled !== true) {
            console.warn(
              '[global-setup] WARNING: chat_enabled is not true. The chat ' +
                'scenario expects LLM_MOCK=true to enable mocked chat (§5/§8). ' +
                'Check the app container environment.',
            );
          }
          return;
        }
        lastError = `status was ${JSON.stringify(body.status)}, expected "ok"`;
      } else {
        lastError = `HTTP ${res.status}`;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `[global-setup] App at ${healthURL} was not ready within ${timeoutMs / 1000}s. ` +
      `Last error: ${lastError}`,
  );
}

export default globalSetup;
