/**
 * The three publisher state machines.
 *
 * Every one of them resolves a `PostResult` and never rejects, and every timer
 * callback is wrapped, because a transient 502 must never take down the host
 * process. Timers are chained `setTimeout`s, never `setInterval`: interval
 * drift causes self-inflicted 429s.
 */
import { backoffMs, type ApiClient, type Outcome, type Priority } from './http.js';
import { collectShards, measureServerCount, type ClientLike, type ShardReport, type Topology } from './topology.js';

export const STATS_INTERVAL_MS = 300_000;
export const STATS_DEBOUNCE_MS = 20_000;
export const STATS_MIN_GAP_MS = 60_000;
/** Republish an unchanged count this often, so a listing never looks abandoned. */
export const STATS_FORCE_AFTER_MS = 1_800_000;
export const STATS_FIRST_POST_DELAY_MS = 5_000;
export const STATS_REMEASURE_MS = 60_000;

export const HEARTBEAT_DEFAULT_INTERVAL_MS = 30_000;
export const HEARTBEAT_MIN_INTERVAL_MS = 15_000;
export const HEARTBEAT_MAX_INTERVAL_MS = 60_000;
export const HEARTBEAT_JITTER_MS = 5_000;

/** Offset from the stats post: the two share one server-side rate budget. */
export const COMMANDS_DELAY_MS = 10_000;

/** The Gold tier is derived per request from Stripe, so it can flip mid-run. */
export const PLAN_REPROBE_MS = 1_800_000;

const MAX_ATTEMPTS = 3;

export type PublisherKind = 'stats' | 'heartbeat' | 'commands';

export interface PostResult {
  ok: boolean;
  status: number | null;
  /** Set when nothing was sent: `'unchanged'`, `'not-elected'`, `'suspended'`, … */
  skipped?: string;
}

export interface PublisherError extends Error {
  type: PublisherKind;
  status: number | null;
  retryable: boolean;
}

export interface PublisherEmitter {
  posted(payload: { type: PublisherKind; status: number }): void;
  error(error: PublisherError): void;
  disabled(payload: { type: PublisherKind; status: number | null; reason: string }): void;
}

export interface PublisherDeps {
  api: ApiClient;
  client: ClientLike;
  topology: Topology;
  /** The Discord *application* id, as a string. */
  botId: string;
  emit: PublisherEmitter;
  /** Called on a 401 so the owner can disable every other publisher too. */
  onAuthFailure?: (() => void) | undefined;
}

function publisherError(
  message: string,
  type: PublisherKind,
  status: number | null,
  retryable: boolean,
): PublisherError {
  return Object.assign(new Error(message), { type, status, retryable });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

abstract class Publisher {
  abstract readonly kind: PublisherKind;

  protected timer: ReturnType<typeof setTimeout> | undefined;
  protected disabledReason: string | undefined;
  protected suspendedUntil = 0;
  private readonly reported = new Set<number>();

  constructor(protected readonly deps: PublisherDeps) {}

  abstract start(): void;

  stop(): void {
    this.clear();
  }

  /** Chained `setTimeout`, never `setInterval`. Always unref'd. */
  protected schedule(delayMs: number, run: () => unknown): void {
    this.clear();
    this.timer = setTimeout(() => {
      // Nothing may throw out of a timer.
      try {
        void Promise.resolve(run()).catch((error: unknown) => this.emitUnexpected(error));
      } catch (error) {
        this.emitUnexpected(error);
      }
    }, Math.max(delayMs, 0));
    this.timer.unref?.();
  }

  protected clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  protected emitUnexpected(error: unknown): void {
    this.deps.emit.error(publisherError(
      error instanceof Error ? error.message : String(error),
      this.kind,
      null,
      false,
    ));
  }

  /** Emit `disabled` exactly once, and stop the loop. */
  protected disable(status: number | null, reason: string): void {
    this.clear();
    if (this.disabledReason !== undefined) return;
    this.disabledReason = reason;
    this.deps.emit.disabled({ type: this.kind, status, reason });
  }

  private reportOnce(status: number, message: string, retryable: boolean): void {
    if (this.reported.has(status)) return;
    this.reported.add(status);
    this.deps.emit.error(publisherError(message, this.kind, status, retryable));
  }

  /**
   * Sends one request, retrying only transient failures.
   *
   * `nextTickInMs` is the time until this publisher's next scheduled run. If a
   * backoff would outlast it, the attempt is dropped: the next tick carries
   * fresher data, and a failed request still burns rate-limit budget.
   */
  protected async send(
    path: string,
    body: unknown,
    priority: Priority,
    nextTickInMs?: number,
  ): Promise<PostResult> {
    let outcome: Outcome = { kind: 'dropped', status: null };

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      outcome = await this.deps.api.post(path, body, priority);
      if (outcome.kind !== 'transient') break;

      const delay = backoffMs(attempt);
      if (attempt === MAX_ATTEMPTS - 1) break;
      if (nextTickInMs !== undefined && delay >= nextTickInMs) break;
      await sleep(delay);
    }

    return this.react(outcome);
  }

  protected react(outcome: Outcome): PostResult {
    switch (outcome.kind) {
      case 'ok':
        this.deps.emit.posted({ type: this.kind, status: outcome.status });
        return { ok: true, status: outcome.status };

      case 'dropped':
        return { ok: false, status: null, skipped: 'suspended' };

      case 'payload':
        // The publisher stays enabled — the next tick may carry valid data.
        this.reportOnce(
          outcome.status,
          `TheDiscordList rejected the ${this.kind} payload (${outcome.status}).`,
          false,
        );
        return { ok: false, status: outcome.status };

      case 'auth':
        this.disable(401, 'unauthorized');
        this.deps.onAuthFailure?.();
        return { ok: false, status: 401 };

      case 'plan':
        // Not a disable: a bot can flip free → Gold mid-run, and requiring a
        // restart to notice would be a support ticket every time.
        this.suspendedUntil = Date.now() + PLAN_REPROBE_MS;
        this.reportOnce(
          403,
          `The ${this.kind} endpoint needs a higher plan. Reprobing in 30 minutes.`,
          false,
        );
        return { ok: false, status: 403, skipped: 'plan' };

      case 'config':
        // 404 is "unknown id, or the id belongs to a server listing" — never
        // "bad token". Do not tell the user their token is wrong.
        this.disable(outcome.status, outcome.status === 409 ? 'conflict' : 'not-found');
        return { ok: false, status: outcome.status };

      case 'throttled':
        return { ok: false, status: 429, skipped: 'throttled' };

      case 'transient':
        this.deps.emit.error(publisherError(
          outcome.error.message,
          this.kind,
          outcome.status,
          true,
        ));
        return { ok: false, status: outcome.status };
    }
  }

  /** An explicit `postX()` re-arms a disabled publisher. A restart is the other way. */
  protected rearm(): void {
    this.disabledReason = undefined;
  }
}

// `| undefined` on every optional: with `exactOptionalPropertyTypes` the
// caller would otherwise have to spread each key conditionally.
export interface StatsOptions {
  interval?: number | undefined;
  debounce?: number | undefined;
  minGap?: number | undefined;
  getServerCount?: (() => number | Promise<number>) | undefined;
}

export class StatsPublisher extends Publisher {
  readonly kind = 'stats' as const;

  private readonly interval: number;
  private readonly debounce: number;
  private readonly minGap: number;
  private readonly getServerCount: (() => number | Promise<number>) | undefined;

  private lastPostAt = 0;
  private lastCount: number | undefined;
  private lastShardCount: number | undefined;
  private debounceCap = 0;
  private inFlight = false;

  constructor(deps: PublisherDeps, options: StatsOptions = {}) {
    super(deps);
    this.interval = options.interval ?? STATS_INTERVAL_MS;
    this.debounce = options.debounce ?? STATS_DEBOUNCE_MS;
    this.minGap = options.minGap ?? STATS_MIN_GAP_MS;
    this.getServerCount = options.getServerCount;
  }

  start(): void {
    this.schedule(STATS_FIRST_POST_DELAY_MS, () => this.tick());
  }

  /** Trailing debounce, hard-capped so a join storm cannot starve the post. */
  onGuildChange(): void {
    if (this.disabledReason !== undefined) return;
    const now = Date.now();
    if (this.debounceCap === 0) this.debounceCap = now + this.minGap;
    this.schedule(Math.min(now + this.debounce, this.debounceCap) - now, () => this.tick());
  }

  async post(): Promise<PostResult> {
    this.rearm();
    return this.publish(true);
  }

  private async tick(): Promise<void> {
    await this.publish(false);
  }

  private async publish(manual: boolean): Promise<PostResult> {
    this.debounceCap = 0;
    if (!manual && this.disabledReason !== undefined) return { ok: false, status: null, skipped: 'disabled' };
    if (this.inFlight) return { ok: false, status: null, skipped: 'in-flight' };

    const now = Date.now();
    if (!manual && now < this.suspendedUntil) {
      this.schedule(this.suspendedUntil - now, () => this.tick());
      return { ok: false, status: null, skipped: 'plan' };
    }

    // A hard monotonic floor. A join storm, a mass reconnect and a manual
    // postStats() all route through it, so the ceiling is structurally
    // 1 req/min rather than statistically.
    if (this.lastPostAt !== 0 && now < this.lastPostAt + this.minGap) {
      this.schedule(this.lastPostAt + this.minGap - now, () => this.tick());
      return { ok: false, status: null, skipped: 'min-gap' };
    }

    this.inFlight = true;
    try {
      const count = await measureServerCount(this.deps.client, this.deps.topology, this.getServerCount);
      if (count === null) {
        this.schedule(STATS_REMEASURE_MS, () => this.tick());
        return {
          ok: false,
          status: null,
          skipped: this.deps.topology.isStatsPublisher ? 'unmeasurable' : 'not-elected',
        };
      }

      const shardCount = this.deps.topology.shardCount;
      // Every /stats post re-indexes Scout, evaluates achievements and fires a
      // bot.stats_reported webhook even when the number did not move. There is
      // no server-side dedupe, so the skip has to happen here.
      if (
        count === this.lastCount
        && shardCount === this.lastShardCount
        && Date.now() < this.lastPostAt + STATS_FORCE_AFTER_MS
      ) {
        this.schedule(this.interval, () => this.tick());
        return { ok: false, status: null, skipped: 'unchanged' };
      }

      this.lastPostAt = Date.now();
      // shard_count is ALWAYS sent: the server writes `$data['shard_count'] ?? null`
      // unconditionally, so omitting it nulls the stored value.
      const result = await this.send(
        `/bots/${this.deps.botId}/stats`,
        { server_count: count, shard_count: shardCount },
        'normal',
        this.interval,
      );

      if (result.ok) {
        this.lastCount = count;
        this.lastShardCount = shardCount;
      }
      if (this.disabledReason === undefined) this.schedule(this.interval, () => this.tick());
      return result;
    } finally {
      this.inFlight = false;
    }
  }
}

interface HeartbeatBody {
  cluster: number;
  cluster_count: number;
  shards: ShardReport[];
}

export class HeartbeatPublisher extends Publisher {
  readonly kind = 'heartbeat' as const;

  private interval: number;
  private startedAt = 0;
  private beats = 0;
  private inFlight = false;
  private nextBeatWithinSeconds: number | undefined;

  constructor(deps: PublisherDeps, options: { interval?: number | undefined } = {}) {
    super(deps);
    this.interval = options.interval ?? HEARTBEAT_DEFAULT_INTERVAL_MS;
  }

  /** Starts on construction, not on ready: a booting bot must read "connecting", not dead. */
  start(): void {
    // Every beat hard-deletes cluster rows with `cluster_id >= cluster_count`
    // from that request, taking `monitoring_since` with it. A process that
    // guesses 1 wipes all of its siblings, so an unknown count means silence.
    if (this.deps.topology.clusterCount === null) {
      this.disable(null, 'cluster-count-unknown');
      return;
    }
    this.startedAt = Date.now();
    this.beats = 0;
    this.schedule(0, () => this.tick());
  }

  /** Out-of-band beat after a shard event. Repeated calls coalesce into one. */
  beatNow(): void {
    if (this.disabledReason !== undefined) return;
    this.schedule(1000, () => this.tick());
  }

  async post(): Promise<PostResult> {
    this.rearm();
    if (this.deps.topology.clusterCount === null) {
      return { ok: false, status: null, skipped: 'cluster-count-unknown' };
    }
    return this.beat(true);
  }

  private async tick(): Promise<void> {
    await this.beat(false);
  }

  private async beat(manual: boolean): Promise<PostResult> {
    if (!manual && this.disabledReason !== undefined) return { ok: false, status: null, skipped: 'disabled' };
    if (this.inFlight) return { ok: false, status: null, skipped: 'in-flight' };

    const clusterCount = this.deps.topology.clusterCount;
    if (clusterCount === null) return { ok: false, status: null, skipped: 'cluster-count-unknown' };

    // Pre-login. The API requires at least one entry in shards[].
    const shards = collectShards(this.deps.client);
    if (shards.length === 0) {
      if (!manual) this.scheduleNext();
      return { ok: false, status: null, skipped: 'no-shards' };
    }

    const body: HeartbeatBody = {
      cluster: this.deps.topology.clusterId,
      cluster_count: clusterCount,
      shards,
    };

    this.inFlight = true;
    let result: PostResult;
    try {
      result = await this.send(`/bots/${this.deps.botId}/heartbeat`, body, 'heartbeat', this.interval);
    } finally {
      this.inFlight = false;
    }

    if (result.ok) this.retune();

    if (!manual && this.disabledReason === undefined) {
      // Never exceed the 90s grace window, even when throttled.
      if (result.skipped === 'throttled') this.scheduleNext(this.interval);
      else this.scheduleNext();
    }
    return result;
  }

  /**
   * The cadence comes from `next_beat_within_seconds` in the response rather
   * than a constant, so a change to the server's grace window retunes existing
   * installs without a release.
   */
  private retune(): void {
    if (this.nextBeatWithinSeconds === undefined) return;
    const proposed = Math.round((this.nextBeatWithinSeconds / 3) * 1000);
    this.interval = Math.min(Math.max(proposed, HEARTBEAT_MIN_INTERVAL_MS), HEARTBEAT_MAX_INTERVAL_MS);
  }

  protected override react(outcome: Outcome): PostResult {
    if (outcome.kind === 'ok') {
      const seconds = (outcome.body as { next_beat_within_seconds?: unknown } | null)
        ?.next_beat_within_seconds;
      this.nextBeatWithinSeconds = typeof seconds === 'number' && seconds > 0 ? seconds : undefined;
    }
    return super.react(outcome);
  }

  /** Absolute-time scheduling, so a slow request cannot drift the cadence. */
  private scheduleNext(minDelayMs = 0): void {
    this.beats += 1;
    const jitter = Math.round(Math.random() * HEARTBEAT_JITTER_MS);
    const target = this.startedAt + this.beats * this.interval + jitter;
    const delay = Math.max(target - Date.now(), minDelayMs, 1000, this.suspendedUntil - Date.now());
    this.schedule(delay, () => this.tick());
  }
}

/** Just enough of `client.rest` to fetch the command list. */
export interface RestLike {
  get(path: string): Promise<unknown>;
}

export class CommandsPublisher extends Publisher {
  readonly kind = 'commands' as const;

  constructor(
    deps: PublisherDeps,
    private readonly rest: RestLike,
    private readonly options: { postEmpty?: boolean | undefined } = {},
  ) {
    super(deps);
  }

  /** Once, ~10s after ready. Commands change on deploy, and a deploy is a restart. */
  start(): void {
    if (!this.deps.topology.isStatsPublisher) return;
    this.schedule(COMMANDS_DELAY_MS, () => this.publish());
  }

  async post(): Promise<PostResult> {
    this.rearm();
    return this.publish();
  }

  private async publish(): Promise<PostResult> {
    if (this.disabledReason !== undefined) return { ok: false, status: null, skipped: 'disabled' };
    if (Date.now() < this.suspendedUntil) return { ok: false, status: null, skipped: 'plan' };

    let raw: unknown;
    try {
      // Never ApplicationCommand#toJSON(): it camelCases every key and returns
      // defaultMemberPermissions as a BigInt, which makes JSON.stringify throw.
      raw = await this.rest.get(`/applications/${this.deps.botId}/commands`);
    } catch (error) {
      this.emitUnexpected(error);
      return { ok: false, status: null, skipped: 'fetch-failed' };
    }

    if (!Array.isArray(raw)) {
      this.emitUnexpected(new Error('Discord returned a non-array command list.'));
      return { ok: false, status: null, skipped: 'fetch-failed' };
    }

    // An empty array CLEARS the listing, so it is never sent by accident.
    if (raw.length === 0 && this.options.postEmpty !== true) {
      return { ok: false, status: null, skipped: 'empty' };
    }

    // Forwarded verbatim. Client-side validation would be actively harmful:
    // Discord sends numbers for INTEGER and NUMBER choice values, which the
    // published spec types as strings and the server accepts.
    return this.send(`/bots/${this.deps.botId}/commands`, { commands: raw }, 'normal');
  }
}
