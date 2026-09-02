import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TdlWebhookError, verifyWebhook } from '../src/webhooks.js';

const SECRET = 'whsec_test';
const NOW = 1_786_712_208_000; // fixed clock, ms
const now = (): number => NOW;

function sign(body: string, t = Math.floor(NOW / 1000), secret = SECRET): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

/** Returns the error code instead of the value, so a failure names the case. */
function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof TdlWebhookError ? error.code : `THREW_${(error as Error).name}`;
  }
}

const body = JSON.stringify({
  id: '5b1f0a2e-1f4d-4a51-9f26-2f9a9c0e1b77',
  event: 'listing.upvoted',
  created_at: '2026-08-14T12:34:56+00:00',
  listing: {
    id: '161660517914509312',
    type: 'bot',
    name: 'Test',
    url: 'https://thediscordlist.com/bots/161660517914509312',
  },
  data: { voted_at: '2026-08-14T12:34:56+00:00', total_upvotes: 42, user: null },
});

describe('verifyWebhook', () => {
  it('accepts a valid signature and returns the parsed payload', () => {
    const event = verifyWebhook(body, sign(body), SECRET, { now });
    expect(event.event).toBe('listing.upvoted');
    if (event.event === 'listing.upvoted') expect(event.data.total_upvotes).toBe(42);
  });

  it('accepts a Buffer body', () => {
    expect(verifyWebhook(Buffer.from(body, 'utf8'), sign(body), SECRET, { now }).id).toBeTruthy();
  });

  it('rejects a wrong secret', () => {
    expect(codeOf(() => verifyWebhook(body, sign(body, undefined, 'whsec_other'), SECRET, { now })))
      .toBe('INVALID_SIGNATURE');
  });

  it('rejects a body altered after signing', () => {
    expect(codeOf(() => verifyWebhook(body.replace('42', '43'), sign(body), SECRET, { now })))
      .toBe('INVALID_SIGNATURE');
  });

  it('rejects a timestamp older than the tolerance', () => {
    expect(codeOf(() => verifyWebhook(body, sign(body, Math.floor(NOW / 1000) - 301), SECRET, { now })))
      .toBe('STALE_TIMESTAMP');
  });

  it('rejects a timestamp too far in the future (two-sided check)', () => {
    expect(codeOf(() => verifyWebhook(body, sign(body, Math.floor(NOW / 1000) + 301), SECRET, { now })))
      .toBe('STALE_TIMESTAMP');
  });

  it('accepts a timestamp inside the tolerance', () => {
    expect(verifyWebhook(body, sign(body, Math.floor(NOW / 1000) - 299), SECRET, { now }).id).toBeTruthy();
  });

  // parseInt('abc') is NaN, and `NaN > tolerance` is false — a naive
  // implementation lets a garbage timestamp straight through the freshness check.
  it('rejects a non-numeric timestamp', () => {
    expect(codeOf(() => verifyWebhook(body, 't=abc,v1=deadbeef', SECRET, { now })))
      .toBe('MALFORMED_SIGNATURE');
  });

  // Buffer.from('zz','hex') is zero-length, which makes timingSafeEqual throw on
  // a length mismatch. @top-gg/sdk@4.0.0 does this inside an async callback with
  // no try/catch: one such request kills the host process.
  it('rejects a non-hex signature without throwing anything else', () => {
    expect(codeOf(() => verifyWebhook(body, 't=1786712208,v1=zz', SECRET, { now })))
      .toBe('INVALID_SIGNATURE');
  });

  it('rejects an empty v1 value', () => {
    expect(codeOf(() => verifyWebhook(body, 't=1786712208,v1=', SECRET, { now })))
      .toBe('MALFORMED_SIGNATURE');
  });

  it('rejects a missing header', () => {
    expect(codeOf(() => verifyWebhook(body, undefined, SECRET, { now }))).toBe('MISSING_SIGNATURE');
  });

  it('accepts an uppercase hex signature', () => {
    const header = sign(body).toUpperCase().replace('T=', 't=').replace('V1=', 'v1=');
    expect(verifyWebhook(body, header, SECRET, { now }).id).toBeTruthy();
  });

  it('rejects a body that is not JSON', () => {
    expect(codeOf(() => verifyWebhook('not json', sign('not json'), SECRET, { now })))
      .toBe('MALFORMED_BODY');
  });

  // The signature covers bytes, not meaning. Anything that re-encodes the body
  // — a JSON body parser plus JSON.stringify, a pretty-printer, a different
  // escaping policy for slashes or non-ASCII — produces a different string and
  // can never verify. This is the regression guard for anyone tempted to accept
  // a parsed object instead of the raw buffer.
  it('fails when the body was re-serialised by a JSON body parser', () => {
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);
    expect(reserialised).not.toBe(body);
    expect(codeOf(() => verifyWebhook(reserialised, sign(body), SECRET, { now })))
      .toBe('INVALID_SIGNATURE');
  });

  // json_encode escapes '/' as '\/' unless JSON_UNESCAPED_SLASHES is set, and
  // JSON.stringify never does. Every listing URL contains slashes, so getting
  // this wrong would break every delivery.
  it('verifies a body containing unescaped slashes and non-ASCII', () => {
    const raw = JSON.stringify({
      id: 'x',
      event: 'webhook.ping',
      created_at: '2026-08-14T12:34:56+00:00',
      listing: { id: '1', type: 'bot', name: 'Tëst', url: 'https://thediscordlist.com/bots/1' },
      data: { message: 'héllo' },
    });
    expect(verifyWebhook(raw, sign(raw), SECRET, { now }).event).toBe('webhook.ping');
  });
});
