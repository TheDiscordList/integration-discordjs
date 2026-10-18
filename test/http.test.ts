import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoffMs, createApiClient, isRetryable, MAX_RATE_LIMIT_WAIT_MS, stripUndefined } from '../src/http.js';

const OPTS = { baseUrl: 'https://thediscordlist.com/api', token: 'tok', userAgent: 'test/1.0' };

function mockFetch(...responses: Array<Response | Error>): ReturnType<typeof vi.fn> {
  const fn = vi.fn();
  for (const response of responses) {
    if (response instanceof Error) fn.mockRejectedValueOnce(response);
    else fn.mockResolvedValueOnce(response);
  }
  // A fresh Response per fallback call: a body can only be read once.
  fn.mockImplementation(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('stripUndefined', () => {
  // A null cluster or cluster_count is a 422: the server only defaults keys
  // that are ABSENT, and neither rule is nullable.
  it('removes undefined keys and keeps a deliberate null', () => {
    expect(stripUndefined({ a: 1, b: undefined, c: null })).toEqual({ a: 1, c: null });
  });

  it('recurses into arrays and nested objects', () => {
    expect(stripUndefined({ s: [{ id: 0, latency_ms: undefined }] })).toEqual({ s: [{ id: 0 }] });
  });
});

describe('createApiClient', () => {
  it('sends bearer auth, JSON and a user agent, and returns the parsed body', async () => {
    const fetchMock = mockFetch(json(200, { message: 'Stats updated.', server_count: 42 }));
    const outcome = await createApiClient(OPTS).post('/bots/1/stats', { server_count: 42 }, 'normal');

    expect(outcome).toEqual({
      kind: 'ok',
      status: 200,
      body: { message: 'Stats updated.', server_count: 42 },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://thediscordlist.com/api/bots/1/stats');
    expect(init.body).toBe('{"server_count":42}');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok');
    expect(headers['content-type']).toBe('application/json');
    expect(headers['user-agent']).toBe('test/1.0');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  // `https://…/api/` + `/bots/…` is a 404, which disables the publisher.
  it('trims trailing slashes from the base URL', async () => {
    const fetchMock = mockFetch(json(200, {}));
    await createApiClient({ ...OPTS, baseUrl: 'https://thediscordlist.com/api//' }).post('/bots/1/stats', {}, 'normal');
    expect(fetchMock.mock.calls[0]![0]).toBe('https://thediscordlist.com/api/bots/1/stats');
  });

  it('strips undefined before serialising', async () => {
    const fetchMock = mockFetch(json(200, {}));
    await createApiClient(OPTS).post('/x', { a: 1, b: undefined }, 'normal');
    expect((fetchMock.mock.calls[0]![1] as RequestInit).body).toBe('{"a":1}');
  });

  it.each([
    [400, 'payload'],
    [422, 'payload'],
    [401, 'auth'],
    [403, 'plan'],
    [404, 'config'],
    [405, 'payload'],
    [409, 'config'],
    [413, 'payload'],
    [500, 'transient'],
    [502, 'transient'],
    [408, 'transient'],
    [425, 'transient'],
  ])('classifies %i as %s', async (status, kind) => {
    mockFetch(json(status, { message: '' }));
    // A next tick 1ms away leaves no room for a retry.
    expect((await createApiClient(OPTS).post('/x', {}, 'normal', 1)).kind).toBe(kind);
  });

  it('classifies a network error as transient', async () => {
    mockFetch(new TypeError('fetch failed'));
    expect(await createApiClient(OPTS).post('/x', {}, 'normal', 1))
      .toMatchObject({ kind: 'transient', status: null });
  });

  it('reads Retry-After on a 429', async () => {
    mockFetch(json(429, { message: 'Too Many Attempts.' }, { 'retry-after': '17' }));
    expect(await createApiClient(OPTS).post('/x', {}, 'normal', 1))
      .toMatchObject({ kind: 'throttled', retryAfterMs: 17_000 });
  });

  it('falls back to 60s when Retry-After is missing', async () => {
    mockFetch(json(429, {}));
    expect(await createApiClient(OPTS).post('/x', {}, 'normal', 1))
      .toMatchObject({ kind: 'throttled', retryAfterMs: 60_000 });
  });

  // One counter per client IP is shared across all three endpoints, so the
  // suspension is one budget, not one per route. A normal-priority job is
  // dropped rather than queued: stats are last-write-wins.
  it('drops a normal-priority request while suspended', async () => {
    mockFetch(json(429, {}, { 'retry-after': '30' }), json(200, {}));
    const client = createApiClient(OPTS);

    await client.post('/x', {}, 'normal', 1);
    expect((await client.post('/x', {}, 'normal')).kind).toBe('dropped');
  });

  // Liveness beats politeness: a dropped heartbeat is a false "down" on the
  // user's public status page.
  it('lets a heartbeat through a suspension', async () => {
    mockFetch(json(429, {}, { 'retry-after': '30' }), json(200, {}));
    const client = createApiClient(OPTS);

    await client.post('/x', {}, 'normal', 1);
    expect((await client.post('/bots/1/heartbeat', {}, 'heartbeat')).kind).toBe('ok');
  });

  it('keeps the suspension per instance, not at module scope', async () => {
    mockFetch(json(429, {}, { 'retry-after': '30' }), json(200, {}));
    await createApiClient(OPTS).post('/x', {}, 'normal', 1);
    expect((await createApiClient(OPTS).post('/x', {}, 'normal')).kind).toBe('ok');
  });

  // A truncated response rejects inside .text(). No public method may reject.
  it('classifies a failed body drain as transient instead of rejecting', async () => {
    const broken = new Response('{}', { status: 200 });
    vi.spyOn(broken, 'text').mockRejectedValue(new TypeError('terminated'));
    mockFetch(broken);

    expect(await createApiClient(OPTS).post('/x', {}, 'normal', 1))
      .toMatchObject({ kind: 'transient', status: 200 });
  });

  it('survives a body that is not JSON', async () => {
    mockFetch(new Response('<html>502</html>', { status: 200 }));
    expect(await createApiClient(OPTS).post('/x', {}, 'normal'))
      .toMatchObject({ kind: 'ok', body: '<html>502</html>' });
  });
});

describe('retries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a transient failure three times and then gives up', async () => {
    const fetchMock = mockFetch(json(500, {}), json(500, {}), json(500, {}));
    const pending = createApiClient(OPTS).post('/x', {}, 'normal', 600_000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await pending).toMatchObject({ kind: 'transient', status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never retries a 4xx it cannot fix', async () => {
    const fetchMock = mockFetch(json(413, {}));
    expect(await createApiClient(OPTS).post('/x', {}, 'normal', 600_000)).toMatchObject({ kind: 'payload' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 once its window lifts, when that is before the next tick', async () => {
    const fetchMock = mockFetch(json(429, {}, { 'retry-after': '1' }));
    const pending = createApiClient(OPTS).post('/x', {}, 'normal', 600_000);
    await vi.advanceTimersByTimeAsync(3_100);

    expect(await pending).toMatchObject({ kind: 'ok' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honours an X-RateLimit-Reset later than Retry-After', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 120);
    mockFetch(json(429, {}, { 'retry-after': '1', 'x-ratelimit-reset': reset }));
    const client = createApiClient(OPTS);

    await client.post('/x', {}, 'normal', 1);
    await vi.advanceTimersByTimeAsync(110_000);
    expect((await client.post('/x', {}, 'normal')).kind).toBe('dropped');
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await client.post('/x', {}, 'normal')).kind).toBe('ok');
  });

  it('never suspends for more than an hour', async () => {
    mockFetch(json(429, {}, { 'retry-after': '86400' }));
    const client = createApiClient(OPTS);

    await client.post('/x', {}, 'normal', 1);
    await vi.advanceTimersByTimeAsync(MAX_RATE_LIMIT_WAIT_MS - 1_000);
    expect((await client.post('/x', {}, 'normal')).kind).toBe('dropped');
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await client.post('/x', {}, 'normal')).kind).toBe('ok');
  });
});

describe('isRetryable', () => {
  it('retries transient and throttled outcomes only', () => {
    expect(isRetryable({ kind: 'transient', status: 500, error: new Error('x') })).toBe(true);
    expect(isRetryable({ kind: 'throttled', status: 429, retryAfterMs: 1 })).toBe(true);
    expect(isRetryable({ kind: 'auth', status: 401 })).toBe(false);
    expect(isRetryable({ kind: 'payload', status: 422 })).toBe(false);
  });
});

describe('backoffMs', () => {
  it('grows exponentially, caps at 30s, and jitters in the upper half', () => {
    expect(backoffMs(0, () => 0)).toBe(500);
    expect(backoffMs(0, () => 1)).toBe(1000);
    expect(backoffMs(1, () => 1)).toBe(2000);
    expect(backoffMs(10, () => 1)).toBe(30_000);
  });
});
