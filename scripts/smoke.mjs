// Proves the built artifact actually runs on the oldest Node in `engines`.
//
// The dev toolchain floors much higher than consumers do — tsdown needs 22.18,
// vitest needs 20 — so no CI row can both build and run on 18.17. This script
// is what keeps `"node": ">=18.17.0"` an audited fact rather than a claim:
// build on a modern Node, then run this one on the oldest supported Node.
//
//   npm run build && npm run smoke
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const roots = [await import('../dist/index.mjs'), require('../dist/index.cjs')];
const webhooks = [await import('../dist/webhooks.mjs'), require('../dist/webhooks.cjs')];

// Loading the root entry point also proves discord.js itself imports here.
for (const root of roots) {
  assert.equal(typeof root.autopost, 'function');
  assert.match(root.version, /^\d+\.\d+\.\d+$/);
}

const body = JSON.stringify({
  id: '5b1f0a2e-1f4d-4a51-9f26-2f9a9c0e1b77',
  event: 'webhook.ping',
  created_at: '2026-08-14T12:34:56+00:00',
  listing: { id: '1', type: 'bot', name: 'T', url: 'https://thediscordlist.com/bots/1' },
  data: { message: 'hello' },
});
const t = Math.floor(Date.now() / 1000);
const secret = 'whsec_smoke';
const valid = `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

// node:crypto and timingSafeEqual are the only runtime APIs this package leans
// on, so exercising them is the whole surface worth smoke-testing.
for (const module of webhooks) {
  assert.equal(module.verifyWebhook(body, valid, secret).event, 'webhook.ping');
  assert.throws(() => module.verifyWebhook(body, `t=${t},v1=zz`, secret), { code: 'INVALID_SIGNATURE' });
}

console.log(`dist loads and verifies on Node ${process.version}`);
