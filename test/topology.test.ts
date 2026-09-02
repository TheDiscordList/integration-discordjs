import { Status } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
  collectShards,
  detectTopology,
  mapShardStatus,
  measureServerCount,
  type ClientLike,
  type Topology,
} from '../src/topology.js';

/** discord.js Collections are Maps plus helpers; `size` and `filter` are all we touch. */
function guildCache(entries: Array<[string, { shardId: number }]>): unknown {
  const map = new Map(entries) as Map<string, { shardId: number }> & {
    filter?: (fn: (guild: { shardId: number }) => boolean) => unknown;
  };
  map.filter = (fn) => guildCache([...map.entries()].filter(([, guild]) => fn(guild)));
  return map;
}

function fakeClient(over: Record<string, unknown> = {}): ClientLike {
  return {
    ws: { shards: new Map([[0, { id: 0, status: Status.Ready, ping: 42 }]]) },
    guilds: { cache: guildCache([['g1', { shardId: 0 }], ['g2', { shardId: 0 }]]) },
    shard: null,
    ...over,
  } as unknown as ClientLike;
}

describe('mapShardStatus', () => {
  it.each([
    [Status.Ready, 'ready'],
    [Status.Resuming, 'resuming'],
    [Status.Disconnected, 'disconnected'],
    [Status.Connecting, 'connecting'],
    [Status.WaitingForGuilds, 'connecting'],
    [Status.Identifying, 'connecting'],
    [Status.Reconnecting, 'connecting'],
    // Idle is the constructor default before connect. Disconnected is set only
    // on an unrecoverable close code, so a booting shard must not read as down.
    [Status.Idle, 'connecting'],
  ])('maps %i', (status, expected) => {
    expect(mapShardStatus(status)).toBe(expected);
  });

  it('falls back to connecting for an unknown value', () => {
    expect(mapShardStatus(99)).toBe('connecting');
  });
});

describe('collectShards', () => {
  it('reports id, status, latency and per-shard guild counts', () => {
    const client = fakeClient({
      ws: {
        shards: new Map([
          [0, { id: 0, status: Status.Ready, ping: 41.6 }],
          [1, { id: 1, status: Status.Resuming, ping: 80 }],
        ]),
      },
      guilds: {
        cache: guildCache([['a', { shardId: 0 }], ['b', { shardId: 1 }], ['c', { shardId: 1 }]]),
      },
    });

    expect(collectShards(client)).toEqual([
      { id: 0, status: 'ready', latency_ms: 42, guilds: 1 },
      { id: 1, status: 'resuming', latency_ms: 80, guilds: 2 },
    ]);
  });

  // ping is -1 before the first heartbeat ACK and the API minimum is 0, so the
  // key must be absent rather than negative.
  it('omits latency_ms when ping is negative', () => {
    const client = fakeClient({
      ws: { shards: new Map([[0, { id: 0, status: Status.Connecting, ping: -1 }]]) },
      guilds: { cache: guildCache([]) },
    });
    expect(collectShards(client)[0]).not.toHaveProperty('latency_ms');
  });

  it('clamps latency to the API maximum', () => {
    const client = fakeClient({
      ws: { shards: new Map([[0, { id: 0, status: Status.Ready, ping: 999_999 }]]) },
      guilds: { cache: guildCache([]) },
    });
    expect(collectShards(client)[0]!.latency_ms).toBe(600_000);
  });
});

describe('detectTopology', () => {
  it('detects a single unsharded process', () => {
    expect(detectTopology(fakeClient(), undefined, {})).toEqual({
      kind: 'single',
      clusterId: 0,
      clusterCount: 1,
      isStatsPublisher: true,
      shardCount: 1,
    });
  });

  it('detects internal sharding as one cluster', () => {
    const client = fakeClient({ ws: { shards: new Map([[0, {}], [1, {}], [2, {}]]) } });
    expect(detectTopology(client, undefined, {})).toMatchObject({
      kind: 'internal',
      clusterId: 0,
      clusterCount: 1,
      isStatsPublisher: true,
      shardCount: 3,
    });
  });

  it('detects ShardingManager and elects shard 0', () => {
    const client = fakeClient({ shard: { ids: [0], count: 4 } });
    expect(detectTopology(client, undefined, { SHARDING_MANAGER: 'true' })).toMatchObject({
      kind: 'sharding-manager',
      clusterId: 0,
      clusterCount: 4,
      isStatsPublisher: true,
    });
  });

  it('does not elect a non-zero ShardingManager shard', () => {
    const client = fakeClient({ shard: { ids: [2], count: 4 } });
    expect(detectTopology(client, undefined, { SHARDING_MANAGER: 'true' })).toMatchObject({
      clusterId: 2,
      clusterCount: 4,
      isStatsPublisher: false,
    });
  });

  it('detects discord-hybrid-sharding from the client and env', () => {
    const client = fakeClient({ cluster: { id: 1, count: 3 } });
    const env = { CLUSTER: '1', CLUSTER_COUNT: '3', TOTAL_SHARDS: '12' };
    expect(detectTopology(client, undefined, env)).toMatchObject({
      kind: 'hybrid',
      clusterId: 1,
      clusterCount: 3,
      isStatsPublisher: false,
      shardCount: 12,
    });
  });

  it('detects indomitable', () => {
    const env = {
      INDOMITABLE_CLUSTER: '0',
      INDOMITABLE_CLUSTER_TOTAL: '2',
      INDOMITABLE_SHARDS_TOTAL: '8',
    };
    expect(detectTopology(fakeClient(), undefined, env)).toMatchObject({
      kind: 'indomitable',
      clusterId: 0,
      clusterCount: 2,
      isStatsPublisher: true,
      shardCount: 8,
    });
  });

  it('prefers an explicit override over detection', () => {
    const client = fakeClient({ shard: { ids: [3], count: 9 } });
    expect(detectTopology(client, { id: 0, count: 2 }, { SHARDING_MANAGER: 'true' })).toMatchObject({
      kind: 'custom',
      clusterId: 0,
      clusterCount: 2,
      isStatsPublisher: true,
    });
  });

  // Every beat hard-deletes cluster rows with cluster_id >= cluster_count from
  // that request. A process that guesses 1 wipes all of its siblings, so an
  // undeterminable count must surface as null and stop the heartbeat.
  it('reports an unknown cluster count as null in a multi-process topology', () => {
    const client = fakeClient({ cluster: { id: 1 } });
    expect(detectTopology(client, undefined, { CLUSTER: '1' }).clusterCount).toBeNull();
  });

  it('ignores a non-numeric cluster count rather than trusting it', () => {
    const client = fakeClient({ cluster: {} });
    expect(detectTopology(client, undefined, { CLUSTER: '0', CLUSTER_COUNT: 'many' }))
      .toMatchObject({ clusterId: 0, clusterCount: null });
  });
});

describe('measureServerCount', () => {
  const single: Topology = {
    kind: 'single',
    clusterId: 0,
    clusterCount: 1,
    isStatsPublisher: true,
    shardCount: 1,
  };
  const managed = (over: Partial<Topology> = {}): Topology => ({
    kind: 'sharding-manager',
    clusterId: 0,
    clusterCount: 3,
    isStatsPublisher: true,
    shardCount: 3,
    ...over,
  });

  it('uses the local cache when unsharded', async () => {
    expect(await measureServerCount(fakeClient(), single, undefined)).toBe(2);
  });

  it('prefers an explicit getServerCount', async () => {
    expect(await measureServerCount(fakeClient(), single, () => 1234)).toBe(1234);
  });

  it('returns null when getServerCount throws or lies', async () => {
    expect(await measureServerCount(fakeClient(), single, () => {
      throw new Error('nope');
    })).toBeNull();
    expect(await measureServerCount(fakeClient(), single, () => -1)).toBeNull();
  });

  it('sums broadcastEval results across shards', async () => {
    const client = fakeClient({
      shard: {
        ids: [0],
        count: 3,
        broadcastEval: vi.fn().mockResolvedValue([
          { ready: true, g: 10 },
          { ready: true, g: 20 },
          { ready: true, g: 30 },
        ]),
      },
    });
    expect(await measureServerCount(client, managed(), undefined)).toBe(60);
  });

  // A connected-but-not-ready shard answers 0 rather than erroring, which would
  // silently undercount the whole bot.
  it('returns null when a shard is not ready', async () => {
    const client = fakeClient({
      shard: {
        ids: [0],
        count: 2,
        broadcastEval: vi.fn().mockResolvedValue([{ ready: true, g: 10 }, { ready: false, g: 0 }]),
      },
    });
    expect(await measureServerCount(client, managed({ clusterCount: 2, shardCount: 2 }), undefined))
      .toBeNull();
  });

  it('returns null when fewer shards answer than expected', async () => {
    const client = fakeClient({
      shard: { ids: [0], count: 3, broadcastEval: vi.fn().mockResolvedValue([{ ready: true, g: 10 }]) },
    });
    expect(await measureServerCount(client, managed(), undefined)).toBeNull();
  });

  it('returns null when broadcastEval rejects', async () => {
    const client = fakeClient({
      shard: {
        ids: [0],
        count: 2,
        broadcastEval: vi.fn().mockRejectedValue(new Error('ShardingInProcess')),
      },
    });
    expect(await measureServerCount(client, managed({ clusterCount: 2, shardCount: 2 }), undefined))
      .toBeNull();
  });

  it('returns null when this process is not the elected publisher', async () => {
    expect(await measureServerCount(fakeClient(), managed({ clusterId: 2, isStatsPublisher: false }), undefined))
      .toBeNull();
  });
});
