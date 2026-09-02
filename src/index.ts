/**
 * TheDiscordList integration for discord.js.
 *
 * ```ts
 * import { Client, GatewayIntentBits } from 'discord.js';
 * import { autopost } from '@thediscordlist/discord.js';
 *
 * const client = new Client({ intents: [GatewayIntentBits.Guilds] });
 * autopost(client, process.env.TDL_TOKEN);
 * client.login(process.env.DISCORD_TOKEN);
 * ```
 */
import { EventEmitter } from 'node:events';
import { Events, GatewayIntentBits, version as discordJsVersion, type Client } from 'discord.js';

import { createApiClient, type ApiClient } from './http.js';
import {
  CommandsPublisher,
  HeartbeatPublisher,
  StatsPublisher,
  type PostResult,
  type PublisherDeps,
  type PublisherEmitter,
  type PublisherError,
  type PublisherKind,
  type RestLike,
} from './publishers.js';
import { detectTopology, type ClientLike, type Topology } from './topology.js';

export type {
  ClientLike,
  ShardReport,
  ShardStatus,
  Topology,
  TopologyKind,
} from './topology.js';
export type { Outcome, Priority } from './http.js';
export type { PostResult, PublisherError, PublisherKind } from './publishers.js';

/** Kept in step with package.json by `test/version.test.ts`. */
export const version = '0.0.0';

export const DEFAULT_BASE_URL = 'https://thediscordlist.com/api';

const LOG_PREFIX = '[@thediscordlist/discord.js]';

export interface AutopostOptions {
  /** Discord application id. Defaults to `client.application.id`. */
  botId?: string | undefined;
  /** Default: `https://thediscordlist.com/api`. */
  baseUrl?: string | undefined;

  stats?: {
    /** Default: true. */
    enabled?: boolean | undefined;
    /** Default: 300000. */
    interval?: number | undefined;
    /** Trailing debounce after guildCreate/guildDelete. Default: 20000. */
    debounce?: number | undefined;
    /** Hard floor between two POSTs. Default: 60000. */
    minGap?: number | undefined;
  } | undefined;

  heartbeat?: {
    /** Default: true. */
    enabled?: boolean | undefined;
    /** Starting cadence; retuned from the API response. Default: 30000. */
    interval?: number | undefined;
  } | undefined;

  commands?: {
    /** Default: true. */
    enabled?: boolean | undefined;
    /** An empty array CLEARS the listing, so it is not sent unless asked. Default: false. */
    postEmpty?: boolean | undefined;
  } | undefined;

  /** Override when a cluster library cannot be auto-detected. */
  cluster?: { id: number; count: number } | undefined;
  /** Escape hatch for exotic topologies. */
  getServerCount?: (() => number | Promise<number>) | undefined;
}

export interface AutoposterEvents {
  posted: [{ type: PublisherKind; status: number }];
  error: [PublisherError];
  disabled: [{ type: PublisherKind; status: number | null; reason: string }];
}

export class Autoposter extends EventEmitter<AutoposterEvents> {
  private stats: StatsPublisher | undefined;
  private heartbeat: HeartbeatPublisher | undefined;
  private commands: CommandsPublisher | undefined;

  private readonly detach: Array<() => void> = [];
  private readonly warned = new Set<string>();
  private stopped = false;
  private built = false;
  private heartbeatStarted = false;

  /** @internal */
  readonly emitter: PublisherEmitter = {
    posted: (payload) => this.emit('posted', payload),
    error: (error) => this.safeEmitError(error),
    disabled: (payload) => this.emit('disabled', payload),
  };

  /** Node throws on an unhandled `'error'` event; a transient 502 must never kill the host. */
  private safeEmitError(error: PublisherError): void {
    if (this.listenerCount('error') > 0) this.emit('error', error);
    else console.warn(`${LOG_PREFIX} ${error.type}: ${error.message}`);
  }

  /** @internal */
  warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`${LOG_PREFIX} ${message}`);
  }

  /** @internal */
  build(client: Client, api: ApiClient, options: AutopostOptions, botId: string): void {
    if (this.stopped || this.built) return;
    this.built = true;

    const structural = client as unknown as ClientLike;
    const topology = detectTopology(structural, options.cluster);
    const deps: PublisherDeps = {
      api,
      client: structural,
      topology,
      botId,
      emit: this.emitter,
      onAuthFailure: () => this.stopPublishers(),
    };

    if (options.stats?.enabled !== false) {
      this.stats = new StatsPublisher(deps, {
        interval: options.stats?.interval,
        debounce: options.stats?.debounce,
        minGap: options.stats?.minGap,
        getServerCount: options.getServerCount,
      });
    }
    if (options.heartbeat?.enabled !== false) {
      this.heartbeat = new HeartbeatPublisher(deps, { interval: options.heartbeat?.interval });
    }
    if (options.commands?.enabled !== false) {
      this.commands = new CommandsPublisher(
        deps,
        client.rest as unknown as RestLike,
        { postEmpty: options.commands?.postEmpty },
      );
    }

    this.wire(client, topology);
  }

  private wire(client: Client, topology: Topology): void {
    const emitter = client as unknown as {
      on(event: string, listener: () => void): void;
      off(event: string, listener: () => void): void;
    };
    const on = (event: string, listener: () => void): void => {
      emitter.on(event, listener);
      this.detach.push(() => emitter.off(event, listener));
    };

    if (this.stats) {
      const bump = (): void => this.stats?.onGuildChange();
      on(Events.GuildCreate, bump);
      on(Events.GuildDelete, bump);
    }

    if (this.heartbeat) {
      // A 30s cadence against a 90s grace leaves no margin during a reconnect,
      // so shard transitions beat out of band. Repeated calls coalesce.
      const beat = (): void => this.heartbeat?.beatNow();
      on(Events.ShardReady, beat);
      on(Events.ShardResume, beat);
      on(Events.ShardDisconnect, beat);
      on(Events.ShardReconnecting, beat);
    }

    if (topology.clusterCount === null) {
      this.warnOnce(
        'cluster-count',
        'Could not determine how many clusters this bot runs. Heartbeats are disabled, because '
        + 'reporting a wrong cluster_count deletes sibling clusters server-side. Pass '
        + 'options.cluster = { id, count } to enable them.',
      );
    }
  }

  /** @internal Heartbeat first: a booting bot must read "connecting", not dead. */
  startHeartbeat(): void {
    if (this.stopped || this.heartbeatStarted || !this.heartbeat) return;
    this.heartbeatStarted = true;
    this.heartbeat.start();
  }

  /** @internal */
  startAll(): void {
    if (this.stopped) return;
    this.startHeartbeat();
    this.stats?.start();
    this.commands?.start();
  }

  private stopPublishers(): void {
    this.stats?.stop();
    this.heartbeat?.stop();
    this.commands?.stop();
  }

  postStats(): Promise<PostResult> {
    return this.stats?.post() ?? Promise.resolve({ ok: false, status: null, skipped: 'disabled' });
  }

  postHeartbeat(): Promise<PostResult> {
    return this.heartbeat?.post() ?? Promise.resolve({ ok: false, status: null, skipped: 'disabled' });
  }

  postCommands(): Promise<PostResult> {
    return this.commands?.post() ?? Promise.resolve({ ok: false, status: null, skipped: 'disabled' });
  }

  /** Clears every timer and detaches every client listener. Not restartable. */
  stop(): void {
    this.stopped = true;
    this.stopPublishers();
    for (const off of this.detach.splice(0)) off();
  }
}

function checkIntents(client: Client, poster: Autoposter): void {
  // `client.options.intents` is a BitFieldResolvable in the types and an
  // IntentsBitField at runtime. Duck-type rather than assume either.
  const intents = (client.options as { intents?: { has?: (bit: bigint | number) => boolean } }).intents;
  if (typeof intents?.has === 'function' && !intents.has(GatewayIntentBits.Guilds)) {
    poster.warnOnce(
      'intents',
      'GatewayIntentBits.Guilds is missing. The guild cache freezes at the READY snapshot, so '
      + 'the reported server count will silently drift.',
    );
  }

  const cache = client.guilds.cache as unknown as { filter?: unknown };
  if (typeof cache.filter !== 'function') {
    poster.warnOnce(
      'guild-cache',
      'client.guilds.cache is not a Collection. A custom makeCache that evicts guilds will '
      + 'undercount both server_count and per-shard guild counts.',
    );
  }
}

/**
 * Wires a discord.js `Client` to a TheDiscordList listing.
 *
 * Safe to call before or after `login()`. With a falsy token it warns once and
 * returns an inert instance — a forgotten environment variable must never take
 * down a deploy.
 */
export function autopost(
  client: Client,
  token: string | undefined,
  options: AutopostOptions = {},
): Autoposter {
  const poster = new Autoposter();

  if (!token) {
    poster.warnOnce('no-token', 'No stats token supplied; auto-posting is disabled.');
    return poster;
  }

  const api = createApiClient({
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    token,
    userAgent: `@thediscordlist/discord.js/${version} (discord.js ${discordJsVersion})`,
  });

  // With an explicit botId the heartbeat can start before login, so a booting
  // bot reports "connecting" rather than looking dead on its status page.
  if (options.botId) {
    poster.build(client, api, options, options.botId);
    checkIntents(client, poster);
    poster.startHeartbeat();
  }

  const start = (): void => {
    const botId = options.botId ?? client.application?.id;
    if (!botId) {
      poster.warnOnce(
        'no-bot-id',
        'Could not read client.application.id. Pass options.botId with your Discord application id.',
      );
      return;
    }
    poster.build(client, api, options, botId);
    checkIntents(client, poster);
    poster.startAll();
  };

  // Always the constant. Subscribing to the literal 'ready' is what triggers
  // discord.js's own deprecation warning.
  if (client.isReady()) start();
  else client.once(Events.ClientReady, start);

  return poster;
}
