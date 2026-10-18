/**
 * TheDiscordList webhook receiver.
 *
 * This entry point imports `node:crypto` and nothing else — no discord.js, not
 * even transitively. That is what makes the discord.js peer dependency
 * optional: a webhook-only consumer never installs it.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const WEBHOOK_SIGNATURE_HEADER = 'x-tdl-signature';
export const DEFAULT_TOLERANCE_SECONDS = 300;
export const DEFAULT_HANDLER_TIMEOUT_MS = 8_000;
export const MAX_BODY_BYTES = 1_048_576;

/**
 * `Carbon::toIso8601String()` — `"2026-08-14T12:34:56+00:00"`. Offset form,
 * never `Z`, never fractional, never a unix integer.
 */
export type TdlIsoDate = string;

export interface TdlWebhookUser {
  /** Nullable even inside a present user object. */
  id: string | null;
  /** Snapshotted at last sign-in — not a live Discord handle. */
  username: string;
  /** Full CDN URL, not a bare avatar hash. */
  avatar: string | null;
}

export interface TdlWebhookListing {
  /** Guild id for a server, application id for a bot. Always a string. */
  id: string;
  type: 'server' | 'bot';
  name: string;
  url: string;
}

export interface TdlEnvelope<E extends string, D> {
  /** UUID, equals `X-TDL-Delivery`, stable across all 5 attempts. Idempotency key. */
  id: string;
  event: E;
  /** Enqueue time, NOT send time. Do not use it for freshness. */
  created_at: TdlIsoDate;
  listing: TdlWebhookListing;
  data: D;
}

export type TdlWebhookPayload =
  | TdlEnvelope<'listing.bumped', {
    points: number;
    bumped_at: TdlIsoDate;
    next_bump_at: TdlIsoDate;
    user: TdlWebhookUser | null;
  }>
  | TdlEnvelope<'listing.bump_ready', {
    ready_at: TdlIsoDate;
  }>
  | TdlEnvelope<'listing.upvoted', {
    voted_at: TdlIsoDate;
    total_upvotes: number;
    user: TdlWebhookUser | null;
  }>
  | TdlEnvelope<'server.joined', {
    joined_at: TdlIsoDate;
    user: TdlWebhookUser | null;
  }>
  | TdlEnvelope<'bot.added', {
    added_at: TdlIsoDate;
    user: TdlWebhookUser | null;
  }>
  | TdlEnvelope<'bot.stats_reported', {
    guild_count: number | null;
    shard_count: number | null;
    reported_at: TdlIsoDate;
  }>
  | TdlEnvelope<'webhook.ping', { message: string }>;

export type TdlWebhookEventName = TdlWebhookPayload['event'];

export type TdlWebhookErrorCode =
  | 'MISSING_SIGNATURE'
  | 'MALFORMED_SIGNATURE'
  | 'STALE_TIMESTAMP'
  | 'INVALID_SIGNATURE'
  | 'MALFORMED_BODY'
  | 'BODY_CONSUMED';

export class TdlWebhookError extends Error {
  constructor(readonly code: TdlWebhookErrorCode, message: string) {
    super(message);
    this.name = 'TdlWebhookError';
  }
}

/** An empty key would make every signature computable by anyone, so it is a setup error. */
function requireSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.trim() === '') {
    throw new TypeError('A webhook secret is required.');
  }
}

/** Length is not secret, and `timingSafeEqual` throws when lengths differ. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export interface VerifyWebhookOptions {
  /** Two-sided freshness window around `t`, in seconds. Default 300. */
  toleranceSeconds?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
}

/**
 * Verifies `X-TDL-Signature` and returns the parsed envelope.
 *
 * `rawBody` must be the exact bytes that arrived. The sender signs the output
 * of one `json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)`
 * and posts that same string, so `JSON.stringify(req.body)` re-escapes slashes
 * and non-ASCII and can never verify.
 *
 * @throws {TdlWebhookError} when the delivery does not verify.
 * @throws {TypeError} when `secret` is empty.
 */
export function verifyWebhook(
  rawBody: string | Uint8Array,
  signatureHeader: string | string[] | undefined,
  secret: string,
  options: VerifyWebhookOptions = {},
): TdlWebhookPayload {
  requireSecret(secret);
  const header = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!header) {
    throw new TdlWebhookError('MISSING_SIGNATURE', `Missing ${WEBHOOK_SIGNATURE_HEADER} header.`);
  }

  // Parse with indexOf, not split('='): a value may legitimately contain '='.
  let timestamp: number | undefined;
  let signature: string | undefined;
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't' && timestamp === undefined) timestamp = Number(value);
    // Exactly one v1 value, ever: one secret column, no rotation grace.
    else if (key === 'v1' && signature === undefined && value !== '') signature = value;
  }

  // `Number('abc')` is NaN and `NaN > tolerance` is false, so an unchecked
  // timestamp would sail straight through the freshness window below.
  if (timestamp === undefined || !Number.isFinite(timestamp) || signature === undefined) {
    throw new TdlWebhookError('MALFORMED_SIGNATURE', `Malformed ${WEBHOOK_SIGNATURE_HEADER} header.`);
  }

  const now = options.now?.() ?? Date.now();
  const tolerance = (options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS) * 1000;
  // Two-sided, so a sender skewed into the future is caught too. Checked
  // against `t`, never `created_at` — that is stamped at enqueue time and can
  // be over an hour older on a retry.
  if (Math.abs(now - timestamp * 1000) > tolerance) {
    throw new TdlWebhookError('STALE_TIMESTAMP', 'Webhook timestamp outside the tolerance window.');
  }

  const raw = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8');
  const expected = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');

  // Compare hex STRINGS. `Buffer.from(sig, 'hex')` silently truncates invalid
  // hex, manufacturing the length mismatch that makes timingSafeEqual throw.
  if (!safeEqual(signature.toLowerCase(), expected)) {
    throw new TdlWebhookError('INVALID_SIGNATURE', 'Webhook signature did not match.');
  }

  try {
    return JSON.parse(raw) as TdlWebhookPayload;
  } catch {
    throw new TdlWebhookError('MALFORMED_BODY', 'Webhook body was not valid JSON.');
  }
}

export interface WebhookContext {
  /** `X-TDL-Delivery`. Stable across all retries — use it as an idempotency key. */
  delivery: string | null;
  /** 1-based. */
  attempt: number;
}

export interface WebhookHandlerOptions {
  secret: string;
  onEvent: (event: TdlWebhookPayload, ctx: WebhookContext) => void | Promise<void>;
  toleranceSeconds?: number;
  /** Milliseconds before the handler is abandoned and `202` returned. Default 8000. */
  handlerTimeoutMs?: number;
  /** Called for every rejected delivery and every handler throw. */
  onError?: (error: unknown) => void;
}

function statusForError(error: unknown): number {
  if (error instanceof TdlWebhookError) {
    return error.code === 'INVALID_SIGNATURE' || error.code === 'MISSING_SIGNATURE' ? 401 : 400;
  }
  return 400;
}

/**
 * Runs the consumer handler under a budget. The sender disables an endpoint
 * after 10 consecutive failed deliveries, so overrunning must still answer 2xx
 * while the work carries on in the background.
 */
async function runHandler(
  options: WebhookHandlerOptions,
  event: TdlWebhookPayload,
  ctx: WebhookContext,
): Promise<number> {
  const budget = options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const overran = new Promise<number>((resolve) => {
    timer = setTimeout(() => resolve(202), budget);
    timer.unref?.();
  });

  const work = (async (): Promise<number> => {
    try {
      await options.onEvent(event, ctx);
      return 204;
    } catch (error) {
      options.onError?.(error);
      return 500;
    }
  })();

  try {
    return await Promise.race([work, overran]);
  } finally {
    clearTimeout(timer);
  }
}

function contextFrom(get: (name: string) => string | null | undefined): WebhookContext {
  const attempt = Number(get('x-tdl-attempt'));
  return {
    delivery: get('x-tdl-delivery') ?? null,
    attempt: Number.isFinite(attempt) && attempt > 0 ? attempt : 1,
  };
}

function verifyOptions(options: WebhookHandlerOptions): VerifyWebhookOptions {
  // Spread rather than pass through: an explicit `undefined` is not the same
  // as an absent key under `exactOptionalPropertyTypes`.
  return options.toleranceSeconds === undefined ? {} : { toleranceSeconds: options.toleranceSeconds };
}

/**
 * Web-standard handler for Hono, Next App Router, Workers, Bun and Deno.
 *
 * ```ts
 * export const POST = createFetchWebhookHandler({ secret, onEvent });
 * ```
 */
export function createFetchWebhookHandler(
  options: WebhookHandlerOptions,
): (request: Request) => Promise<Response> {
  requireSecret(options.secret);
  return async (request) => {
    if (request.method !== 'POST') return new Response(null, { status: 405 });

    const raw = await request.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return new Response(null, { status: 413 });

    let event: TdlWebhookPayload;
    try {
      event = verifyWebhook(
        raw,
        request.headers.get(WEBHOOK_SIGNATURE_HEADER) ?? undefined,
        options.secret,
        verifyOptions(options),
      );
    } catch (error) {
      options.onError?.(error);
      return new Response(null, { status: statusForError(error) });
    }

    const status = await runHandler(options, event, contextFrom((n) => request.headers.get(n)));
    return new Response(null, { status });
  };
}

/**
 * `node:http` and express/connect handler. It reads the stream itself, so it
 * must be mounted before any JSON body parser; a raw `Buffer` body from
 * `express.raw()` is used as is.
 *
 * ```ts
 * app.post('/tdl', createWebhookHandler({ secret, onEvent }));
 * ```
 */
export function createWebhookHandler(
  options: WebhookHandlerOptions,
): (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => void {
  requireSecret(options.secret);
  return (req, res) => {
    void (async (): Promise<void> => {
      const end = (status: number): void => {
        res.statusCode = status;
        res.end();
      };

      if (req.method !== 'POST') return end(405);

      let raw: Uint8Array;
      if (req.body instanceof Uint8Array) {
        raw = req.body;
        if (raw.byteLength > MAX_BODY_BYTES) return end(413);
      } else if (req.body !== undefined) {
        // A body parser ran first and destroyed the raw bytes. Say so loudly:
        // a silent verification failure here is hours of debugging.
        options.onError?.(new TdlWebhookError(
          'BODY_CONSUMED',
          'Request body was already parsed, so the signed bytes are gone. Mount this handler '
          + "before any JSON body parser, or use express.raw({ type: 'application/json' }) on this route.",
        ));
        return end(500);
      } else {
        let size = 0;
        const chunks: Buffer[] = [];
        try {
          for await (const chunk of req) {
            const buf = Buffer.from(chunk as Buffer);
            size += buf.length;
            if (size > MAX_BODY_BYTES) return end(413);
            chunks.push(buf);
          }
        } catch (error) {
          options.onError?.(error);
          return end(400);
        }
        raw = Buffer.concat(chunks);
      }

      let event: TdlWebhookPayload;
      try {
        event = verifyWebhook(
          raw,
          req.headers[WEBHOOK_SIGNATURE_HEADER],
          options.secret,
          verifyOptions(options),
        );
      } catch (error) {
        options.onError?.(error);
        return end(statusForError(error));
      }

      const status = await runHandler(options, event, contextFrom((n) => {
        const value = req.headers[n];
        return Array.isArray(value) ? value[0] : value;
      }));
      end(status);
    })();
  };
}
