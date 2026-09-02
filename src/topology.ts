/**
 * Sharding-topology detection, publisher election and guild counting.
 *
 * Three signals, no dependencies: environment variables, `client.shard`
 * (non-null iff `SHARDING_MANAGER` is set) and a duck-typed `client.cluster`.
 * Both aggregation buses expose the same surface, so one code path serves all
 * of them.
 */
// Always from 'discord.js'. `@discordjs/ws` exports a *different* Status enum
// with colliding numbers.
import { Status } from 'discord.js';

/** The API caps `latency_ms` here; `ping` can spike far past it after a stall. */
export const MAX_LATENCY_MS = 600_000;

export type ShardStatus = 'ready' | 'connecting' | 'resuming' | 'disconnected';

export interface ShardReport {
  id: number;
  status: ShardStatus;
  latency_ms?: number;
  guilds: number;
}

export type TopologyKind =
  | 'single'
  | 'internal'
  | 'sharding-manager'
  | 'hybrid'
  | 'indomitable'
  | 'custom';

export interface Topology {
  kind: TopologyKind;
  clusterId: number;
  /** `null` means undeterminable — the heartbeat publisher must not start. */
  clusterCount: number | null;
  isStatsPublisher: boolean;
  shardCount: number;
}

/**
 * Structural, never `instanceof`: duplicate discord.js copies under pnpm and
 * in monorepos break identity checks reliably.
 */
export interface ClientLike {
  ws: {
    shards: {
      size: number;
      values(): Iterable<{ id: number; status: number; ping: number }>;
    };
  };
  guilds: {
    cache: {
      size: number;
      filter(fn: (guild: { shardId: number }) => boolean): { size: number };
    };
  };
  shard?: { ids: number[]; count: number; broadcastEval?: unknown } | null;
  cluster?: { id?: number; count?: number; broadcastEval?: unknown } | null;
}

const STATUS_MAP: Readonly<Record<number, ShardStatus>> = {
  [Status.Ready]: 'ready',
  [Status.Connecting]: 'connecting',
  [Status.Reconnecting]: 'connecting',
  // The constructor default before connect. `Disconnected` is set only on an
  // unrecoverable close code, so reporting Idle as down would page someone
  // every time a bot boots.
  [Status.Idle]: 'connecting',
  [Status.Nearly]: 'connecting',
  [Status.Disconnected]: 'disconnected',
  [Status.WaitingForGuilds]: 'connecting',
  [Status.Identifying]: 'connecting',
  [Status.Resuming]: 'resuming',
};

export function mapShardStatus(status: number): ShardStatus {
  return STATUS_MAP[status] ?? 'connecting';
}

export function collectShards(client: ClientLike): ShardReport[] {
  return [...client.ws.shards.values()].map((shard) => {
    const report: ShardReport = {
      id: shard.id,
      status: mapShardStatus(shard.status),
      guilds: client.guilds.cache.filter((guild) => guild.shardId === shard.id).size,
    };
    // `ping` is -1 before the first heartbeat ACK and the API minimum is 0, so
    // the key is omitted rather than sent negative.
    if (shard.ping >= 0) report.latency_ms = Math.min(Math.round(shard.ping), MAX_LATENCY_MS);
    return report;
  });
}

function positiveInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function detectTopology(
  client: ClientLike,
  override?: { id: number; count: number },
  env: NodeJS.ProcessEnv = process.env,
): Topology {
  const localShards = client.ws.shards.size || 1;

  if (override) {
    return {
      kind: 'custom',
      clusterId: override.id,
      clusterCount: override.count,
      isStatsPublisher: override.id === 0,
      shardCount: localShards,
    };
  }

  // discord-hybrid-sharding. Its own `getInfo()` throws outside cluster mode,
  // so read the client and the environment instead.
  if (client.cluster) {
    const id = client.cluster.id ?? nonNegativeInt(env.CLUSTER) ?? 0;
    return {
      kind: 'hybrid',
      clusterId: id,
      clusterCount: client.cluster.count ?? positiveInt(env.CLUSTER_COUNT),
      isStatsPublisher: id === 0,
      shardCount: positiveInt(env.TOTAL_SHARDS) ?? localShards,
    };
  }

  if (env.INDOMITABLE_CLUSTER_TOTAL !== undefined) {
    const id = nonNegativeInt(env.INDOMITABLE_CLUSTER) ?? 0;
    return {
      kind: 'indomitable',
      clusterId: id,
      clusterCount: positiveInt(env.INDOMITABLE_CLUSTER_TOTAL),
      isStatsPublisher: id === 0,
      shardCount: positiveInt(env.INDOMITABLE_SHARDS_TOTAL) ?? localShards,
    };
  }

  if (client.shard) {
    const id = client.shard.ids[0] ?? 0;
    const count = client.shard.count > 0 ? client.shard.count : null;
    return {
      kind: 'sharding-manager',
      clusterId: id,
      clusterCount: count,
      isStatsPublisher: id === 0,
      shardCount: count ?? localShards,
    };
  }

  return {
    kind: localShards > 1 ? 'internal' : 'single',
    clusterId: 0,
    clusterCount: 1,
    isStatsPublisher: true,
    shardCount: localShards,
  };
}

interface EvalRow {
  ready: boolean;
  g: number;
}

function aggregationBus(
  client: ClientLike,
): { count: number; broadcastEval: (fn: unknown) => Promise<unknown[]> } | null {
  const bus = (client.cluster ?? client.shard) as
    | { count?: number; broadcastEval?: (fn: unknown) => Promise<unknown[]> }
    | null
    | undefined;
  if (!bus || typeof bus.broadcastEval !== 'function' || typeof bus.count !== 'number') return null;
  return { count: bus.count, broadcastEval: bus.broadcastEval.bind(bus) };
}

/**
 * Returns `null` when the count cannot be trusted, so the caller retries later
 * rather than publishing a wrong number.
 */
export async function measureServerCount(
  client: ClientLike,
  topology: Topology,
  getServerCount?: () => number | Promise<number>,
): Promise<number | null> {
  if (getServerCount) {
    try {
      const value = await getServerCount();
      return Number.isInteger(value) && value >= 0 ? value : null;
    } catch {
      return null;
    }
  }

  // The guild cache is already complete at READY, unavailable stubs included —
  // exactly what a bot list wants — and it does not drop during a Discord
  // outage, because GUILD_DELETE with `unavailable: true` only flips a flag.
  // So a local read needs no sanity backstop.
  if (topology.kind === 'single' || topology.kind === 'internal') return client.guilds.cache.size;

  if (!topology.isStatsPublisher) return null;

  const bus = aggregationBus(client);
  if (!bus) return null;

  let rows: unknown[];
  try {
    // ShardingInProcess / ShardingNoChildExists reject the whole Promise.all.
    rows = await bus.broadcastEval((c: { isReady(): boolean; guilds: { cache: { size: number } } }) => ({
      ready: c.isReady(),
      g: c.guilds.cache.size,
    }));
  } catch {
    return null;
  }

  // Arity guard. discord-hybrid-sharding's own is commented out upstream, so a
  // short answer would silently undercount the whole bot.
  if (rows.length !== bus.count) return null;

  let total = 0;
  for (const row of rows as EvalRow[]) {
    // A connected-but-not-ready shard answers 0 rather than erroring.
    if (!row || row.ready !== true || !Number.isInteger(row.g)) return null;
    total += row.g;
  }
  return total;
}
