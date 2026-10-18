// Receiving webhooks in Express.
//
//   node examples/webhooks-express.mjs
//
// Environment: TDL_WEBHOOK_SECRET.
import express from 'express';
import { createWebhookHandler } from '@thediscordlist/discord.js/webhooks';

const app = express();

const handler = createWebhookHandler({
  secret: process.env.TDL_WEBHOOK_SECRET,

  async onEvent(event, ctx) {
    // ctx.delivery equals X-TDL-Delivery and is stable across all five attempts.
    // Use it as an idempotency key; a manual "redeliver" from the UI mints a
    // new uuid on purpose, so it is not dropped as a duplicate.
    //
    //   if (await redis.set(ctx.delivery, 1, 'EX', 86400, 'NX') === null) return;

    switch (event.event) {
      case 'listing.upvoted':
        console.log(`Upvote #${event.data.total_upvotes} from ${event.data.user?.username ?? 'someone'}`);
        break;
      case 'listing.bumped':
        console.log(`Bumped; next bump at ${event.data.next_bump_at}`);
        break;
      case 'bot.added':
        console.log('Someone clicked Invite');
        break;
      case 'webhook.ping':
        // Delivered to every endpoint regardless of its events array, and every
        // 6 hours to a failure-disabled one. A 2xx here is what re-enables it.
        console.log('Ping:', event.data.message);
        break;
      default:
        // Anything unrecognised still gets a 2xx. A 500 counts toward the
        // sender's 10-delivery disable threshold.
        console.log('Unhandled event', event.event, 'attempt', ctx.attempt);
    }
  },

  onError: (error) => console.warn('[tdl webhook]', error.code ?? error),
});

// This handler reads the raw stream itself, so mount it before any body parser.
// If you must put express.raw() in front of it, always pass an explicit type:
// bare express.raw() defaults to application/octet-stream and silently skips
// JSON, leaving req.body undefined.
app.post('/webhooks/tdl', handler);

app.use(express.json()); // the rest of your app, after the webhook route

app.listen(3000, () => console.log('Listening on http://localhost:3000/webhooks/tdl'));
