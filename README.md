# @thediscordlist/discord.js

Publish your discord.js bot's server count, cluster heartbeats and application
commands to [TheDiscordList](https://thediscordlist.com) automatically, and
verify its inbound webhooks.

Zero runtime dependencies. Works unchanged under every sharding topology
discord.js supports.

```sh
npm install @thediscordlist/discord.js
```

## Quickstart

```ts
import { Client, GatewayIntentBits } from 'discord.js';
import { autopost } from '@thediscordlist/discord.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

autopost(client, process.env.TDL_TOKEN);

client.login(process.env.DISCORD_TOKEN);
```

That is the whole integration, and it is also the recommended production setup.
It starts three publishers:

| Publisher | What it sends | Cadence |
| --- | --- | --- |
| Stats | `server_count`, `shard_count` | 5s after ready, then every 5 min, debounced on guild join/leave |
| Heartbeat | per-shard status, latency and guild counts | every ~30s, plus immediately on any shard transition |
| Commands | your registered slash commands | once, ~10s after ready |

Your **stats token** is on the listing's manage page, under the API tab. It is
scoped to one listing, so it is the only credential this package needs.

`autopost` is safe to call before or after `login()`. With a missing token it
warns once and returns an inert object — a forgotten environment variable never
takes down a deploy.

## Sharding

No configuration. Detection is a pure function of your environment plus the
client, and every layout is covered:

| Topology | `server_count` comes from | Stats posted by | Heartbeats |
| --- | --- | --- | --- |
| Single process | the local guild cache | this process | this process |
| Internal sharding | the local guild cache | this process | this process |
| `ShardingManager` | `broadcastEval` sum | shard 0 | every shard, for itself |
| discord-hybrid-sharding | `cluster.broadcastEval` sum | cluster 0 | every cluster, for itself |
| indomitable | the local cache (warns once) | cluster 0 | every cluster, for itself |
| something else | your `getServerCount()` | as configured | as configured |

Every process heartbeats for **itself** on purpose. A manager reporting "all
fine" for a cluster whose host has died is exactly the failure the status page
exists to catch.

For a cluster library this package cannot recognise, name the topology yourself:

```ts
autopost(client, process.env.TDL_TOKEN, {
  cluster: { id: Number(process.env.MY_CLUSTER_ID), count: Number(process.env.MY_CLUSTER_COUNT) },
  getServerCount: () => myBus.sumGuildCounts(),
});
```

> **If the cluster count cannot be determined, heartbeats do not start.** The
> API hard-deletes every cluster row whose id is `>= cluster_count` in the
> request, so one process guessing `1` would erase all of its siblings and
> their monitoring history. The package emits a `disabled` event naming
> `options.cluster` as the fix. Losing a status page beats losing data.

## Options

```ts
autopost(client, token, {
  botId: '161660517914509312', // default: client.application.id
  baseUrl: 'https://thediscordlist.com/api',

  stats: { enabled: true, interval: 300_000, debounce: 20_000, minGap: 60_000 },
  heartbeat: { enabled: true, interval: 30_000 },
  commands: { enabled: true, postEmpty: false },

  cluster: { id: 0, count: 1 },
  getServerCount: () => 1234,
});
```

`minGap` is a hard floor between two stats POSTs. A join storm, a mass
reconnect and a manual `postStats()` all route through it, so the ceiling is
structurally one request per minute.

`commands.postEmpty` is `false` because posting an empty array **clears** the
command list on your listing. Turn it on only if that is what you mean.

## Events and manual posting

```ts
const poster = autopost(client, process.env.TDL_TOKEN);

poster.on('posted', ({ type, status }) => {});
poster.on('error', (error) => {}); // error.type, error.status, error.retryable
poster.on('disabled', ({ type, status, reason }) => {});

await poster.postStats();     // never rejects; resolves { ok, status, skipped? }
await poster.postCommands();
await poster.postHeartbeat();

poster.stop();
```

Nothing in this package throws at your process. Timer callbacks are wrapped,
`postX()` always resolves, and an `error` event with no listener attached is
logged with `console.warn` rather than emitted — Node kills a process on an
unhandled `'error'`.

An explicit `postX()` also re-arms a publisher that disabled itself, so you can
retry after fixing a token or a listing id without restarting.

## Webhooks

A separate entry point that imports only `node:crypto`. It does not load
discord.js, so a webhook-only service does not need it installed.

### Express / `node:http`

```ts
import express from 'express';
import { createWebhookHandler } from '@thediscordlist/discord.js/webhooks';

const app = express();

app.post('/webhooks/tdl', createWebhookHandler({
  secret: process.env.TDL_WEBHOOK_SECRET,
  onEvent: async (event, ctx) => { /* … */ },
}));

app.use(express.json()); // everything else, after the webhook route
```

The handler reads the raw stream itself, so mount it **before** any body
parser. If your framework forces one in front, it must hand over raw bytes:

```ts
app.post('/webhooks/tdl', express.raw({ type: 'application/json' }), handler);
```

`express.raw()` with no options defaults `type` to `application/octet-stream`
and silently skips JSON, leaving `req.body` undefined. The handler detects an
already-parsed body and reports a `BODY_CONSUMED` error rather than failing
verification for reasons nobody can see.

### Hono, Next App Router, Workers, Bun, Deno

```ts
import { createFetchWebhookHandler } from '@thediscordlist/discord.js/webhooks';

export const POST = createFetchWebhookHandler({ secret, onEvent });
```

```ts
// Hono
app.post('/webhooks/tdl', (c) => handler(c.req.raw));
```

### Fastify

```ts
import rawBody from 'fastify-raw-body';
import { verifyWebhook } from '@thediscordlist/discord.js/webhooks';

await app.register(rawBody, { field: 'rawBody', global: false, encoding: false });

app.post('/webhooks/tdl', { config: { rawBody: true } }, async (req, reply) => {
  const event = verifyWebhook(req.rawBody, req.headers['x-tdl-signature'], secret);
  await handle(event);
  return reply.code(204).send();
});
```

### Verifying by hand

```ts
import { verifyWebhook, TdlWebhookError } from '@thediscordlist/discord.js/webhooks';

try {
  const event = verifyWebhook(rawBody, req.headers['x-tdl-signature'], secret);
} catch (error) {
  if (error instanceof TdlWebhookError) return res.status(400).end(); // error.code says why
}
```

`rawBody` must be the exact bytes that arrived, as a string or a `Buffer`.
`JSON.stringify(req.body)` re-encodes the payload and can never verify: the
signature covers bytes, not meaning.

### Events

```ts
type TdlWebhookEventName =
  | 'listing.bumped'
  | 'listing.upvoted'
  | 'server.joined'   // server listings only — a bot listing never receives it
  | 'bot.added'
  | 'bot.stats_reported'
  | 'webhook.ping';
```

`event.event` is a discriminant, so narrowing gives you a typed `event.data`.

Two of them are not what their names suggest. `bot.added` is a **click** event,
dispatched on the install hand-off — Discord never tells anyone whether the
install completed. And `bot.stats_reported` is not an echo of your own POST: it
also fires when the owner edits the listing in the web UI, and from the
heartbeat's internal stats forward.

### Rules for a healthy endpoint

- **Always answer 2xx**, including for `webhook.ping` and for event names you
  do not recognise. The sender disables an endpoint after 10 consecutive failed
  deliveries — about 50 requests over 11.5 hours. A 500 on an unknown event is
  a self-inflicted outage. The handlers here already do this for you.
- A disabled endpoint is probed with a `webhook.ping` every 6 hours for 7 days,
  and **a 2xx to that probe re-enables it**.
- **Register an exact `https://` URL with no redirect.** The sender treats 3xx
  as a failure, so an `http → https` or trailing-slash redirect burns all five
  retries and counts toward the disable streak.
- **Deduplicate on `ctx.delivery`.** It equals `X-TDL-Delivery` and is stable
  across all five retries of one delivery:

  ```ts
  if (await redis.set(ctx.delivery, 1, 'EX', 86400, 'NX') === null) return;
  ```

  There is no in-process cache in this package on purpose — it would be wrong
  under exactly the clustered topologies the package exists to serve. A manual
  "redeliver" from the UI mints a new uuid deliberately, so it is not dropped.
- **Rotating the secret has no grace window.** It is a destructive overwrite,
  and deliveries already queued under the old secret become unverifiable.
- Handlers get an 8 second budget. Overrun and the endpoint answers `202` while
  your work continues, so the delivery is not retried and not counted as a
  failure. Tune with `handlerTimeoutMs`.

## Plans, limits and known behaviour

- **Heartbeats need Gold or higher.** On a `403` the heartbeat publisher
  suspends and reprobes every 30 minutes rather than disabling: the tier is
  derived per request, so a bot can gain it mid-run.
- **Rate limits are shared.** The API counts stats, heartbeats and commands
  against one budget keyed by client IP. This package keeps one client-side
  budget to match, and drops stats before heartbeats when it is scarce — a
  stale number beats a false "down" on your status page. On shared hosting,
  other bots behind the same egress IP count against you.
- **`404` never means "bad token".** It means the id is unknown or belongs to a
  server listing. The distinction is deliberate, so probing cannot enumerate.
- **Guild counts can drift upward permanently.** If Discord re-IDENTIFYs a
  shard, discord.js may keep guilds you were removed from while offline. No
  client-side fix exists; restarting the shard clears it.
- Missing `GatewayIntentBits.Guilds` freezes the guild cache at the READY
  snapshot, so the count silently stops moving. The package warns once.

## Requirements

- Node.js `>= 18.17`
- discord.js `^14.22` (optional peer — the `/webhooks` entry point does not need it)

discord.js v15 is not supported yet: it removes the sharding APIs detection
reads, and widening the peer range without a tested path would be a promise
this package could not keep.

## Publishing (maintainers)

Releases run through changesets and npm trusted publishing (OIDC) — there is no
`NPM_TOKEN`. One-time setup CI cannot do:

1. Create the `@thediscordlist` npm organisation.
2. `npm publish --access public` once, by hand.
3. On the package's **access** page, register the trusted publisher naming this
   repository and `release.yml`. `repository.url` in `package.json` must match
   exactly.

## License

MIT
