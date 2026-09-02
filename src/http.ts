/**
 * The one HTTP client every publisher shares.
 *
 * There is a single client-side suspension rather than one per endpoint,
 * because the server keeps a single rate-limit counter per client IP across
 * every bot route (only the threshold differs). Heartbeats bypass it: a
 * dropped stats post is a stale number, a dropped heartbeat is a false "down"
 * on the user's public status page.
 */
export const DEFAULT_TIMEOUT_MS = 10_000;

export type Outcome =
  | { kind: 'ok'; status: number; body: unknown }
  | { kind: 'payload'; status: number }
  | { kind: 'auth'; status: 401 }
  | { kind: 'plan'; status: 403 }
  | { kind: 'config'; status: number }
  | { kind: 'throttled'; status: 429; retryAfterMs: number }
  | { kind: 'transient'; status: number | null; error: Error }
  | { kind: 'dropped'; status: null };

export type Priority = 'normal' | 'heartbeat';

export interface ApiClient {
  post(path: string, body: unknown, priority: Priority): Promise<Outcome>;
}

export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  userAgent: string;
  timeoutMs?: number;
}

/**
 * Drops `undefined` keys recursively. An explicit `null` survives, and must:
 * the API's `prepareForValidation` only defaults keys that are *absent*, and
 * none of its rules are `nullable`, so a serialised `undefined` is a 422.
 */
export function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => stripUndefined(item)) as unknown as T;
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item !== undefined) out[key] = stripUndefined(item);
  }
  return out as T;
}

export function isRetryable(outcome: Outcome): boolean {
  return outcome.kind === 'transient';
}

/** Full jitter in the upper half, capped at 30s. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  return Math.round(Math.min(1000 * 2 ** attempt, 30_000) * (0.5 + random() * 0.5));
}

/**
 * Server-side precedence is 404 → 429 → 401 → 422 → 403/409 → 200. Gates fire
 * *after* validation, so plan state is only inferable from a clean payload.
 */
function classify(status: number, body: unknown, retryAfterHeader: string | null): Outcome {
  if (status >= 200 && status < 300) return { kind: 'ok', status, body };
  if (status === 401) return { kind: 'auth', status: 401 };
  if (status === 403) return { kind: 'plan', status: 403 };
  // 404 is "unknown id, or the id belongs to a server listing" — deliberately
  // never "bad token", so anti-enumeration holds. Do not report it as auth.
  if (status === 404 || status === 409) return { kind: 'config', status };
  if (status === 400 || status === 422) return { kind: 'payload', status };
  if (status === 429) {
    const seconds = Number(retryAfterHeader);
    return {
      kind: 'throttled',
      status: 429,
      retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000,
    };
  }
  return { kind: 'transient', status, error: new Error(`TheDiscordList responded ${status}.`) };
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  // Instance state, never module state: a dual ESM+CJS package loaded in both
  // formats would otherwise share one budget across two unrelated posters.
  let suspendedUntil = 0;

  return {
    async post(path, body, priority) {
      if (priority !== 'heartbeat' && Date.now() < suspendedUntil) {
        return { kind: 'dropped', status: null };
      }

      let response: Response;
      try {
        response = await fetch(`${options.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.token}`,
            'content-type': 'application/json',
            'user-agent': options.userAgent,
          },
          body: JSON.stringify(stripUndefined(body)),
          // Global fetch has no overall timeout. This timer is unref'd, so it
          // will not hold the event loop open on its own.
          signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
      } catch (error) {
        return { kind: 'transient', status: null, error: error as Error };
      }

      // Always drain the body, or undici holds the socket open. A truncated
      // response rejects here, and no public method may ever reject.
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        return { kind: 'transient', status: response.status, error: error as Error };
      }

      let parsed: unknown;
      try {
        parsed = text === '' ? null : JSON.parse(text);
      } catch {
        parsed = text;
      }

      const outcome = classify(response.status, parsed, response.headers.get('retry-after'));
      if (outcome.kind === 'throttled') {
        const reset = Number(response.headers.get('x-ratelimit-reset'));
        const untilReset = Number.isFinite(reset) && reset > 0 ? reset * 1000 : 0;
        suspendedUntil = Math.max(Date.now() + outcome.retryAfterMs, untilReset)
          + Math.round(Math.random() * 2000);
      }
      return outcome;
    },
  };
}
