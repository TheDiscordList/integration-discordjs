# @thediscordlist/discord.js

## 0.2.0

### Minor Changes

- 07a053c: The heartbeat keeps its regular schedule through shard transitions: an out-of-band beat no longer pushes the next regular beat back (five transitions used to delay it past the server's 90s grace), waits at least 10s after the previous beat, and is skipped during a plan suspension. After a long suspension it resumes at its normal cadence instead of beating once a second to catch up. Suspensions and gaps run on `performance.now()`, and a configured heartbeat interval is clamped to 15–60s.
- ab22b44: `createWebhookHandler` verifies a `Buffer` body from `express.raw({ type: 'application/json' })`, the setup the README recommends, instead of answering 500 `BODY_CONSUMED`. `verifyWebhook` and both handlers throw a `TypeError` for an empty secret instead of verifying against an empty key. Adds the `listing.bump_ready` event, with `data.ready_at`.

### Patch Changes

- bdc82f2: Only network errors, 408, 425, 429 and 5xx are retried; any other 4xx is reported once and not resent. A 429 is retried once its window lifts, if that comes before the next tick, and no rate-limit wait lasts longer than an hour. A trailing slash on `baseUrl` no longer produces a 404.
- af41dec: A token pasted with surrounding whitespace or a leading `Bearer ` is accepted. The default intervals are exported as `STATS_INTERVAL_MS`, `STATS_DEBOUNCE_MS`, `STATS_MIN_GAP_MS` and `HEARTBEAT_DEFAULT_INTERVAL_MS`.

## 0.1.1

### Patch Changes

- 80a65b0: Report the real package version in the user agent; 0.1.0 sent `0.0.0`. Releases now go through npm staged publishing, so every version is approved by a maintainer before it goes live.

## 0.1.0

### Minor Changes

- 05a88f4: Initial release: `autopost()` publishes server counts, cluster heartbeats and
  application commands from any discord.js sharding topology, and
  `@thediscordlist/discord.js/webhooks` verifies and handles inbound webhooks.
