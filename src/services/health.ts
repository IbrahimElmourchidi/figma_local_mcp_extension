import { bridgeUrl } from '../util/bridgeUrl';
import { BRIDGE_HEALTH_PATH, HEALTH_TIMEOUT_MS } from '../constants';
import { BridgeError } from '../errors';

export interface HealthResult {
  readonly ok: boolean;
  readonly status?: number;
  readonly sessionId?: string;
  readonly error?: string;
}

export async function probeHealth(
  host: string,
  port: number,
  token?: string,
  timeoutMs = HEALTH_TIMEOUT_MS,
): Promise<HealthResult> {
  const url = `${bridgeUrl({ host, port })}${BRIDGE_HEALTH_PATH}`;
  try {
    const headers: Record<string, string> = {};
    if (token && token.length > 0) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 200) {
      let sessionId: string | undefined;
      try {
        const body = (await response.json()) as { sessionId?: string };
        sessionId = body.sessionId;
      } catch {
        // ignore body parse failures
      }
      return { ok: true, status: 200, sessionId };
    }
    return { ok: false, status: response.status, error: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function assertHealthy(
  host: string,
  port: number,
  token?: string,
  timeoutMs = HEALTH_TIMEOUT_MS,
): Promise<HealthResult> {
  const result = await probeHealth(host, port, token, timeoutMs);
  if (!result.ok) {
    throw new BridgeError('health_gate_failed', result.error ?? 'Bridge health check failed');
  }
  return result;
}

/** Poll until healthy or deadline (ms). Returns the first healthy result or the last failure. */
export async function waitForHealth(
  host: string,
  port: number,
  token: string | undefined,
  deadlineMs: number,
  intervalMs = 200,
): Promise<HealthResult> {
  const end = Date.now() + deadlineMs;
  let last: HealthResult = { ok: false, error: 'not started' };
  while (Date.now() < end) {
    last = await probeHealth(host, port, token, Math.min(1000, deadlineMs));
    if (last.ok) {
      return last;
    }
    await new Promise((r) => {
      const t = setTimeout(r, intervalMs);
      t.unref?.();
    });
  }
  return last;
}
