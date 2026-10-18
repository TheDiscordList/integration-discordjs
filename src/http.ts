/**
 * The one HTTP client every publisher shares.
 *
 * There is a single client-side suspension rather than one per endpoint,
 * because the server counts stats and commands against one per-bot budget.
 * Heartbeats bypass it: a
 * dropped stats post is a stale number, a dropped heartbeat is a false "down"
 * on the user's public status page.
 */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** However far out Retry-After or X-RateLimit-Reset points, never go quiet for longer. */
export const MAX_RATE_LIMIT_WAIT_MS = 3_600_000;

const MAX_ATTEMPTS = 3;

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
  /**
   * One request, retrying transient failures and, once its window lifts, a 429.
   *
   * `nextTickInMs` is the time until the caller runs again. If a wait would
   * outlast it, the attempt is dropped: the next tick carries fresher data,
   * and a failed request still burns rate-limit budget.
   */
  post(path: string, body: unknown, priority: Priority, nextTickInMs?: number): Promise<Outcome>;
}

export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  userAgent: string;
  timeoutMs?: number;
}

/**
 * Drops `undefined` keys recursively, so an unset value arrives absent rather
 * than `null`. The API's `prepareForValidation` only defaults keys that are
 * *absent*, and `cluster`, `cluster_count` and `shards` are not `nullable`, so
 * a `null` there is a 422. An explicit `null` survives: where a rule is
 * nullable it is a deliberate "unknown".
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
  return outcome.kind === 'transient' || outcome.kind === 'throttled';
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
  if (status === 429) {
    const seconds = Number(retryAfterHeader);
    return {
      kind: 'throttled',
      status: 429,
      retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000,
    };
  }
  // Retrying the same request cannot turn any other 4xx into a success.
  if (status >= 400 && status < 500 && status !== 408 && status !== 425) return { kind: 'payload', status };
  return { kind: 'transient', status, error: new Error(`TheDiscordList responded ${status}.`) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  // Instance state, never module state: a dual ESM+CJS package loaded in both
  // formats would otherwise share one budget across two unrelated posters.
  let suspendedUntil = 0;

  async function once(path: string, body: unknown, ignoreLimit: boolean): Promise<Outcome> {
    if (!ignoreLimit && performance.now() < suspendedUntil) {
      return { kind: 'dropped', status: null };
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
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
      // An absolute unix time, so it is read against the wall clock once.
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      const untilReset = Number.isFinite(reset) && reset > 0 ? reset * 1000 - Date.now() : 0;
      suspendedUntil = performance.now()
        + Math.min(Math.max(outcome.retryAfterMs, untilReset), MAX_RATE_LIMIT_WAIT_MS)
        + Math.round(Math.random() * 2000);
    }
    return outcome;
  }

  return {
    async post(path, body, priority, nextTickInMs) {
      let outcome: Outcome = { kind: 'dropped', status: null };
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        // A request that just waited out the window goes through it, even if
        // its timer fires a tick early.
        outcome = await once(path, body, priority === 'heartbeat' || outcome.kind === 'throttled');
        if (!isRetryable(outcome) || attempt === MAX_ATTEMPTS - 1) break;

        const delay = outcome.kind === 'throttled' ? suspendedUntil - performance.now() : backoffMs(attempt);
        if (nextTickInMs !== undefined && delay >= nextTickInMs) break;
        await sleep(delay);
      }
      return outcome;
    },
  };
}
