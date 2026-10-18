import { Events, Status } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';
import { autopost } from '../src/index.js';

function guildCache(size: number): unknown {
  const entries: Array<[string, { shardId: number }]> = [];
  for (let i = 0; i < size; i++) entries.push([`g${i}`, { shardId: 0 }]);
  const map = new Map(entries) as Map<string, { shardId: number }> & { filter?: unknown };
  map.filter = (fn: (guild: { shardId: number }) => boolean) =>
    new Map([...map.entries()].filter(([, guild]) => fn(guild)));
  return map;
}

interface FakeClient {
  once: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  isReady: () => boolean;
  application: { id: string } | null;
  options: { intents: { has: () => boolean } };
  guilds: { cache: unknown };
  ws: { shards: Map<number, unknown> };
  shard: null;
  rest: { get: ReturnType<typeof vi.fn> };
  fire: (event: string) => void;
}

function fakeClient(over: Partial<FakeClient> = {}): FakeClient {
  const listeners = new Map<string, Array<() => void>>();
  const add = (event: string, listener: () => void): void => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener]);
  };

  return {
    once: vi.fn(add),
    on: vi.fn(add),
    off: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, (listeners.get(event) ?? []).filter((l) => l !== listener));
    }),
    isReady: () => false,
    application: { id: '161660517914509312' },
    options: { intents: { has: () => true } },
    guilds: { cache: guildCache(3) },
    ws: { shards: new Map([[0, { id: 0, status: Status.Ready, ping: 30 }]]) },
    shard: null,
    rest: { get: vi.fn().mockResolvedValue([]) },
    fire: (event: string) => {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    ...over,
  };
}

function stubFetch(status = 200, body: unknown = {}): ReturnType<typeof vi.fn> {
  // A fresh Response per call: a body can only be read once.
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const start = (client: FakeClient): Client => client as unknown as Client;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('autopost', () => {
  // A forgotten environment variable must never take down a deploy.
  it('returns an inert instance and warns once when the token is missing', async () => {
    const fetchMock = stubFetch();
    const client = fakeClient({ isReady: () => true });

    const poster = autopost(start(client), '');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await poster.postStats()).toMatchObject({ ok: false, skipped: 'disabled' });
    poster.stop();
  });

  it('defers all work until the client is ready', async () => {
    const fetchMock = stubFetch();
    const client = fakeClient();

    const poster = autopost(start(client), 'tok');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();

    client.fire(Events.ClientReady);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(fetchMock).toHaveBeenCalled();
    poster.stop();
  });

  // Attaching a listener to the literal 'ready' is what triggers discord.js's
  // own deprecation warning: emit() returns true only when listeners exist.
  it('subscribes with Events.ClientReady, never the string "ready"', () => {
    const client = fakeClient();
    stubFetch();

    const poster = autopost(start(client), 'tok');

    expect(client.once).toHaveBeenCalledWith(Events.ClientReady, expect.any(Function));
    expect(client.once).not.toHaveBeenCalledWith('ready', expect.anything());
    poster.stop();
  });

  it('starts immediately when the client is already ready', async () => {
    const fetchMock = stubFetch();
    const poster = autopost(start(fakeClient({ isReady: () => true })), 'tok');

    await vi.advanceTimersByTimeAsync(11_000);

    const paths = fetchMock.mock.calls.map(([url]) => String(url));
    expect(paths.some((p) => p.endsWith('/heartbeat'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/stats'))).toBe(true);
    poster.stop();
  });

  // Without the Guilds intent the cache freezes at the READY snapshot and the
  // reported server count drifts forever, silently.
  it('warns once about a missing Guilds intent', async () => {
    stubFetch();
    const client = fakeClient({ isReady: () => true, options: { intents: { has: () => false } } });

    const poster = autopost(start(client), 'tok');
    await vi.advanceTimersByTimeAsync(11_000);

    const warnings = vi.mocked(console.warn).mock.calls.filter(([m]) => String(m).includes('Guilds'));
    expect(warnings).toHaveLength(1);
    poster.stop();
  });

  // Node throws on an unhandled 'error' event. A transient 502 must never kill
  // the host process.
  it('falls back to console.warn when nothing is listening for errors', async () => {
    stubFetch(500, { message: '' });
    const poster = autopost(start(fakeClient({ isReady: () => true })), 'tok');

    const pending = poster.postStats();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(await pending).toMatchObject({ ok: false, status: 500 });
    expect(console.warn).toHaveBeenCalled();
    poster.stop();
  });

  it('routes errors to a listener when one is attached', async () => {
    stubFetch(500, { message: '' });
    const poster = autopost(start(fakeClient({ isReady: () => true })), 'tok');
    const onError = vi.fn();
    poster.on('error', onError);

    const pending = poster.postStats();
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ type: 'stats', retryable: true }));
    poster.stop();
  });

  it('stop() clears every timer and detaches every client listener', () => {
    stubFetch();
    const client = fakeClient({ isReady: () => true });
    const poster = autopost(start(client), 'tok');

    expect(vi.getTimerCount()).toBeGreaterThan(0);
    poster.stop();

    expect(vi.getTimerCount()).toBe(0);
    expect(client.off).toHaveBeenCalled();
  });

  it('sends a user agent naming both packages', async () => {
    const fetchMock = stubFetch();
    const poster = autopost(start(fakeClient({ isReady: () => true })), 'tok');
    await vi.advanceTimersByTimeAsync(11_000);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['user-agent'])
      .toMatch(/^@thediscordlist\/discord\.js\/\d+\.\d+\.\d+ \(discord\.js .+\)$/);
    poster.stop();
  });

  it.each(['  tok\n', 'Bearer tok', 'bearer   tok '])('cleans up a pasted token: %j', async (token) => {
    const fetchMock = stubFetch();
    const poster = autopost(start(fakeClient({ isReady: () => true })), token);
    await vi.advanceTimersByTimeAsync(1);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    poster.stop();
  });

  it('treats a blank token as missing', async () => {
    const fetchMock = stubFetch();
    const poster = autopost(start(fakeClient({ isReady: () => true })), '   ');
    await vi.advanceTimersByTimeAsync(11_000);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await poster.postStats()).toMatchObject({ skipped: 'disabled' });
  });

  it('starts the heartbeat before login when botId is supplied', async () => {
    const fetchMock = stubFetch();
    const poster = autopost(start(fakeClient()), 'tok', { botId: '42' });

    await vi.advanceTimersByTimeAsync(1);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://thediscordlist.com/api/bots/42/heartbeat');
    poster.stop();
  });
});
