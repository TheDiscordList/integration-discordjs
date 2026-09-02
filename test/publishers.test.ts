import { Status } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, Outcome } from '../src/http.js';
import {
  COMMANDS_DELAY_MS,
  CommandsPublisher,
  HeartbeatPublisher,
  PLAN_REPROBE_MS,
  STATS_DEBOUNCE_MS,
  STATS_FIRST_POST_DELAY_MS,
  STATS_INTERVAL_MS,
  StatsPublisher,
  type PublisherDeps,
} from '../src/publishers.js';
import type { ClientLike, Topology } from '../src/topology.js';

type PostMock = ReturnType<typeof vi.fn>;

const OK: Outcome = { kind: 'ok', status: 200, body: {} };

function makeApi(always: Outcome = OK): ApiClient & { post: PostMock } {
  const post = vi.fn().mockResolvedValue(always);
  return { post } as unknown as ApiClient & { post: PostMock };
}

function guildCache(entries: Array<[string, { shardId: number }]>): unknown {
  const map = new Map(entries) as Map<string, { shardId: number }> & { filter?: unknown };
  map.filter = (fn: (guild: { shardId: number }) => boolean) =>
    guildCache([...map.entries()].filter(([, guild]) => fn(guild)));
  return map;
}

function fakeClient(over: Record<string, unknown> = {}): ClientLike {
  return {
    ws: { shards: new Map([[0, { id: 0, status: Status.Ready, ping: 42 }]]) },
    guilds: { cache: guildCache([['a', { shardId: 0 }], ['b', { shardId: 0 }]]) },
    shard: null,
    ...over,
  } as unknown as ClientLike;
}

const SINGLE: Topology = {
  kind: 'single',
  clusterId: 0,
  clusterCount: 1,
  isStatsPublisher: true,
  shardCount: 1,
};

function makeEmit(): PublisherDeps['emit'] & Record<'posted' | 'error' | 'disabled', PostMock> {
  return { posted: vi.fn(), error: vi.fn(), disabled: vi.fn() } as never;
}

function makeDeps(over: Partial<PublisherDeps> = {}): PublisherDeps {
  return {
    api: makeApi(),
    client: fakeClient(),
    topology: SINGLE,
    botId: '1',
    emit: makeEmit(),
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('StatsPublisher', () => {
  it('posts once after ready, and always sends shard_count', async () => {
    const api = makeApi();
    const publisher = new StatsPublisher(makeDeps({ api }));

    publisher.start();
    await vi.advanceTimersByTimeAsync(STATS_FIRST_POST_DELAY_MS);

    // shard_count is never omitted: the server writes `$data['shard_count'] ?? null`
    // unconditionally, so leaving it out nulls the stored value.
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith(
      '/bots/1/stats',
      { server_count: 2, shard_count: 1 },
      'normal',
    );
    publisher.stop();
  });

  // Every /stats post re-indexes Scout, evaluates achievements and fires a
  // bot.stats_reported webhook, even when the number did not move.
  it('skips a tick whose count has not changed', async () => {
    const api = makeApi();
    const publisher = new StatsPublisher(makeDeps({ api }));

    publisher.start();
    await vi.advanceTimersByTimeAsync(STATS_FIRST_POST_DELAY_MS);
    await vi.advanceTimersByTimeAsync(STATS_INTERVAL_MS);

    expect(api.post).toHaveBeenCalledTimes(1);
    publisher.stop();
  });

  it('republishes an unchanged count once the force window elapses', async () => {
    const api = makeApi();
    const publisher = new StatsPublisher(makeDeps({ api }));

    publisher.start();
    await vi.advanceTimersByTimeAsync(STATS_FIRST_POST_DELAY_MS);
    await vi.advanceTimersByTimeAsync(1_900_000);

    expect(api.post).toHaveBeenCalledTimes(2);
    publisher.stop();
  });

  it('coalesces a burst of guild changes into one post', async () => {
    const api = makeApi();
    const publisher = new StatsPublisher(makeDeps({ api }));

    publisher.onGuildChange();
    publisher.onGuildChange();
    publisher.onGuildChange();
    await vi.advanceTimersByTimeAsync(STATS_DEBOUNCE_MS);

    expect(api.post).toHaveBeenCalledTimes(1);
    publisher.stop();
  });

  // A hard monotonic floor, not a statistical one: a join storm, a mass
  // reconnect and a manual postStats() all route through it.
  it('never posts twice inside the minimum gap, even when called directly', async () => {
    const api = makeApi();
    const publisher = new StatsPublisher(makeDeps({ api }));

    await publisher.post();
    const second = await publisher.post();

    expect(second.skipped).toBe('min-gap');
    expect(api.post).toHaveBeenCalledTimes(1);
    publisher.stop();
  });

  it('retries a transient failure three times and then gives up', async () => {
    const api = makeApi({ kind: 'transient', status: 500, error: new Error('bad gateway') });
    const publisher = new StatsPublisher(makeDeps({ api }));

    const pending = publisher.post();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await pending).toMatchObject({ ok: false, status: 500 });
    expect(api.post).toHaveBeenCalledTimes(3);
    publisher.stop();
  });

  it('disables itself exactly once on a 401 and clears its timer', async () => {
    const api = makeApi({ kind: 'auth', status: 401 });
    const emit = makeEmit();
    const publisher = new StatsPublisher(makeDeps({ api, emit }));

    publisher.start();
    await vi.advanceTimersByTimeAsync(STATS_FIRST_POST_DELAY_MS);

    expect(emit.disabled).toHaveBeenCalledTimes(1);
    expect(emit.disabled).toHaveBeenCalledWith({ type: 'stats', status: 401, reason: 'unauthorized' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a 422 once and stays enabled, because the next tick may be valid', async () => {
    const api = makeApi({ kind: 'payload', status: 422 });
    const emit = makeEmit();
    const publisher = new StatsPublisher(makeDeps({ api, emit }));

    publisher.start();
    await vi.advanceTimersByTimeAsync(STATS_FIRST_POST_DELAY_MS);
    await vi.advanceTimersByTimeAsync(STATS_INTERVAL_MS + 1000);

    expect(api.post.mock.calls.length).toBeGreaterThan(1);
    expect(emit.error).toHaveBeenCalledTimes(1);
    expect(emit.disabled).not.toHaveBeenCalled();
    publisher.stop();
  });
});

describe('HeartbeatPublisher', () => {
  it('beats immediately rather than waiting for ready', async () => {
    const api = makeApi();
    const publisher = new HeartbeatPublisher(makeDeps({ api }));

    publisher.start();
    await vi.advanceTimersByTimeAsync(1);

    // A booting bot must read "connecting" on its status page, not dead.
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith(
      '/bots/1/heartbeat',
      { cluster: 0, cluster_count: 1, shards: [{ id: 0, status: 'ready', latency_ms: 42, guilds: 2 }] },
      'heartbeat',
    );
    publisher.stop();
  });

  // A wrong cluster_count hard-deletes every sibling cluster row server-side,
  // monitoring_since included. Silence is the only safe answer.
  it('refuses to start when the cluster count is unknown', async () => {
    const api = makeApi();
    const emit = makeEmit();
    const publisher = new HeartbeatPublisher(
      makeDeps({ api, emit, topology: { ...SINGLE, kind: 'hybrid', clusterCount: null } }),
    );

    publisher.start();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(emit.disabled).toHaveBeenCalledWith({
      type: 'heartbeat',
      status: null,
      reason: 'cluster-count-unknown',
    });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('skips a beat before login, because the API requires at least one shard', async () => {
    const api = makeApi();
    const publisher = new HeartbeatPublisher(
      makeDeps({ api, client: fakeClient({ ws: { shards: new Map() } }) }),
    );

    publisher.start();
    await vi.advanceTimersByTimeAsync(1);

    expect(api.post).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    publisher.stop();
  });

  it('retunes its cadence from next_beat_within_seconds', async () => {
    const api = makeApi({ kind: 'ok', status: 200, body: { next_beat_within_seconds: 45 } });
    const publisher = new HeartbeatPublisher(makeDeps({ api }));

    publisher.start();
    await vi.advanceTimersByTimeAsync(1);
    // 45 / 3 = 15s, clamped to the 15s floor. Plus up to 5s of jitter.
    await vi.advanceTimersByTimeAsync(21_000);

    expect(api.post).toHaveBeenCalledTimes(2);
    publisher.stop();
  });

  it('keeps the 30s default when the response says nothing', async () => {
    const api = makeApi();
    const publisher = new HeartbeatPublisher(makeDeps({ api }));

    publisher.start();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(21_000);

    expect(api.post).toHaveBeenCalledTimes(1);
    publisher.stop();
  });

  // The Gold tier is derived per request from Stripe, so a bot can flip
  // free → Gold mid-run. Disabling would need a restart to notice.
  it('suspends for 30 minutes on a 403 instead of disabling', async () => {
    const api = makeApi({ kind: 'plan', status: 403 });
    const emit = makeEmit();
    const publisher = new HeartbeatPublisher(makeDeps({ api, emit }));

    publisher.start();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(emit.disabled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(PLAN_REPROBE_MS);
    expect(api.post).toHaveBeenCalledTimes(2);
    publisher.stop();
  });

  it('reschedules inside the 90s grace window after a 429', async () => {
    const api = makeApi({ kind: 'throttled', status: 429, retryAfterMs: 300_000 });
    const publisher = new HeartbeatPublisher(makeDeps({ api }));

    publisher.start();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(59_000);

    expect(api.post.mock.calls.length).toBeGreaterThan(1);
    publisher.stop();
  });

  it('coalesces a storm of out-of-band beats into one', async () => {
    const api = makeApi();
    const publisher = new HeartbeatPublisher(makeDeps({ api }));

    for (let i = 0; i < 20; i++) publisher.beatNow();
    await vi.advanceTimersByTimeAsync(1500);

    expect(api.post).toHaveBeenCalledTimes(1);
    publisher.stop();
  });
});

describe('CommandsPublisher', () => {
  const commands = [{ id: '9', name: 'ping', description: 'Pong.', options: [] }];

  it('forwards the raw REST response verbatim', async () => {
    const api = makeApi();
    const rest = { get: vi.fn().mockResolvedValue(commands) };
    const publisher = new CommandsPublisher(makeDeps({ api }), rest);

    publisher.start();
    await vi.advanceTimersByTimeAsync(COMMANDS_DELAY_MS);

    expect(rest.get).toHaveBeenCalledWith('/applications/1/commands');
    expect(api.post).toHaveBeenCalledWith('/bots/1/commands', { commands }, 'normal');
    publisher.stop();
  });

  it('never sends an empty array by accident, because it clears the listing', async () => {
    const api = makeApi();
    const publisher = new CommandsPublisher(makeDeps({ api }), { get: vi.fn().mockResolvedValue([]) });

    expect(await publisher.post()).toMatchObject({ skipped: 'empty' });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('sends an empty array when postEmpty is set', async () => {
    const api = makeApi();
    const publisher = new CommandsPublisher(
      makeDeps({ api }),
      { get: vi.fn().mockResolvedValue([]) },
      { postEmpty: true },
    );

    await publisher.post();
    expect(api.post).toHaveBeenCalledWith('/bots/1/commands', { commands: [] }, 'normal');
  });

  it('does nothing on a process that is not the elected publisher', async () => {
    const rest = { get: vi.fn() };
    const publisher = new CommandsPublisher(
      makeDeps({ topology: { ...SINGLE, isStatsPublisher: false } }),
      rest,
    );

    publisher.start();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rest.get).not.toHaveBeenCalled();
  });

  it('disables itself once on a 409 and does not retry', async () => {
    const api = makeApi({ kind: 'config', status: 409 });
    const emit = makeEmit();
    const publisher = new CommandsPublisher(
      makeDeps({ api, emit }),
      { get: vi.fn().mockResolvedValue(commands) },
    );

    await publisher.post();

    expect(api.post).toHaveBeenCalledTimes(1);
    expect(emit.disabled).toHaveBeenCalledTimes(1);
    expect(emit.disabled).toHaveBeenCalledWith({ type: 'commands', status: 409, reason: 'conflict' });
  });

  it('survives a REST failure without rejecting', async () => {
    const emit = makeEmit();
    const publisher = new CommandsPublisher(
      makeDeps({ emit }),
      { get: vi.fn().mockRejectedValue(new Error('Missing Access')) },
    );

    expect(await publisher.post()).toMatchObject({ ok: false, skipped: 'fetch-failed' });
    expect(emit.error).toHaveBeenCalled();
  });
});
