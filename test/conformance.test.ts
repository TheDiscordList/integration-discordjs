import { Status } from 'discord.js';
import { describe, expect, it } from 'vitest';
import fixture from './fixtures/sdk-conformance.json' with { type: 'json' };
import {
  backoffMs,
  DEFAULT_TIMEOUT_MS,
  MAX_ATTEMPTS,
  MAX_RATE_LIMIT_WAIT_MS,
  RATE_LIMIT_DEFAULT_MS,
  RATE_LIMIT_JITTER_MS,
} from '../src/http.js';
import { DEFAULT_BASE_URL } from '../src/index.js';
import {
  COMMANDS_DELAY_MS,
  COMMANDS_RETRY_MS,
  HEARTBEAT_DEFAULT_INTERVAL_MS,
  HEARTBEAT_JITTER_MS,
  PLAN_REPROBE_MS,
  STATS_DEBOUNCE_MS,
  STATS_FIRST_POST_DELAY_MS,
  STATS_FORCE_AFTER_MS,
  STATS_INTERVAL_MS,
  STATS_MIN_GAP_MS,
} from '../src/publishers.js';
import { mapShardStatus } from '../src/topology.js';
import { DEFAULT_TOLERANCE_SECONDS, TdlWebhookError, verifyWebhook } from '../src/webhooks.js';

describe('the shared SDK conformance fixture', () => {
  const { secret, tolerance_seconds, vectors } = fixture.webhook_signature;

  it.each(vectors)('verifies the webhook vector "$name"', ({ now, body, header, valid }) => {
    const verify = (): unknown => verifyWebhook(body, header, secret, { now: () => now * 1000 });

    if (valid) expect(verify).not.toThrow();
    else expect(verify).toThrow(TdlWebhookError);
  });

  it('shares every default', () => {
    expect(DEFAULT_TOLERANCE_SECONDS).toBe(tolerance_seconds);
    expect({
      base_url: DEFAULT_BASE_URL,
      timeout_seconds: DEFAULT_TIMEOUT_MS / 1000,
      retry: {
        attempts: MAX_ATTEMPTS,
        backoff_base_seconds: backoffMs(0, () => 1) / 1000,
        backoff_max_seconds: backoffMs(99, () => 1) / 1000,
      },
      rate_limit: {
        default_seconds: RATE_LIMIT_DEFAULT_MS / 1000,
        max_seconds: MAX_RATE_LIMIT_WAIT_MS / 1000,
        jitter_max_seconds: RATE_LIMIT_JITTER_MS / 1000,
      },
      forbidden_reprobe_seconds: PLAN_REPROBE_MS / 1000,
      stats: {
        first_delay_seconds: STATS_FIRST_POST_DELAY_MS / 1000,
        interval_seconds: STATS_INTERVAL_MS / 1000,
        debounce_seconds: STATS_DEBOUNCE_MS / 1000,
        min_gap_seconds: STATS_MIN_GAP_MS / 1000,
        force_after_seconds: STATS_FORCE_AFTER_MS / 1000,
      },
      heartbeat: {
        interval_seconds: HEARTBEAT_DEFAULT_INTERVAL_MS / 1000,
        jitter_max_seconds: HEARTBEAT_JITTER_MS / 1000,
      },
      commands: {
        first_delay_seconds: COMMANDS_DELAY_MS / 1000,
        retry_seconds: COMMANDS_RETRY_MS / 1000,
      },
    }).toEqual(fixture.defaults);
  });

  it('reports exactly the shared shard states', () => {
    const numeric = Object.values(Status).filter((value): value is number => typeof value === 'number');
    expect(new Set(numeric.map(mapShardStatus))).toEqual(new Set(fixture.shard_states));
  });
});
