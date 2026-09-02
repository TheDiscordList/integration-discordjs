// Receiving webhooks anywhere the Fetch API lives: Hono, Next App Router,
// Cloudflare Workers, Bun, Deno.
//
//   node examples/webhooks-hono.mjs
//
// Environment: TDL_WEBHOOK_SECRET.
import { Hono } from 'hono';
import { createFetchWebhookHandler } from '@thediscordlist/discord.js/webhooks';

const handler = createFetchWebhookHandler({
  secret: process.env.TDL_WEBHOOK_SECRET,
  onEvent: (event, ctx) => {
    console.log(event.event, event.listing.name, `(delivery ${ctx.delivery})`);
  },
});

const app = new Hono();

// c.req.raw is the standard Request; the handler reads the raw bytes from it.
app.post('/webhooks/tdl', (c) => handler(c.req.raw));

// Next App Router is the same function with no wrapper at all:
//   export const POST = createFetchWebhookHandler({ secret, onEvent });

export default app;
