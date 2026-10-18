import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createFetchWebhookHandler, createWebhookHandler, MAX_BODY_BYTES } from '../src/webhooks.js';

const SECRET = 'whsec_test';
const DELIVERY = '5b1f0a2e-1f4d-4a51-9f26-2f9a9c0e1b77';

function signature(body: string): string {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex')}`;
}

function signed(body: string): Headers {
  return new Headers({
    'content-type': 'application/json',
    'x-tdl-signature': signature(body),
    'x-tdl-event': 'webhook.ping',
    'x-tdl-delivery': DELIVERY,
    'x-tdl-attempt': '2',
  });
}

const ping = JSON.stringify({
  id: DELIVERY,
  event: 'webhook.ping',
  created_at: '2026-08-14T12:34:56+00:00',
  listing: { id: '1', type: 'bot', name: 'T', url: 'https://thediscordlist.com/bots/1' },
  data: { message: 'hello' },
});

function post(body: string, headers = signed(body)): Request {
  return new Request('https://example.test/tdl', { method: 'POST', headers, body });
}

describe('createFetchWebhookHandler', () => {
  it('returns 204 and passes the delivery context', async () => {
    const onEvent = vi.fn();
    const res = await createFetchWebhookHandler({ secret: SECRET, onEvent })(post(ping));

    expect(res.status).toBe(204);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'webhook.ping' }),
      { delivery: DELIVERY, attempt: 2 },
    );
  });

  it('defaults attempt to 1 when the header is absent', async () => {
    const onEvent = vi.fn();
    const headers = signed(ping);
    headers.delete('x-tdl-attempt');
    headers.delete('x-tdl-delivery');
    await createFetchWebhookHandler({ secret: SECRET, onEvent })(post(ping, headers));

    expect(onEvent).toHaveBeenCalledWith(expect.anything(), { delivery: null, attempt: 1 });
  });

  it('returns 401 for a bad signature', async () => {
    const headers = signed(ping);
    headers.set('x-tdl-signature', `t=${Math.floor(Date.now() / 1000)},v1=deadbeef`);
    const res = await createFetchWebhookHandler({ secret: SECRET, onEvent: vi.fn() })(post(ping, headers));
    expect(res.status).toBe(401);
  });

  it('returns 400 for a malformed header', async () => {
    const headers = signed(ping);
    headers.set('x-tdl-signature', 'garbage');
    const res = await createFetchWebhookHandler({ secret: SECRET, onEvent: vi.fn() })(post(ping, headers));
    expect(res.status).toBe(400);
  });

  it('returns 405 for a non-POST request', async () => {
    const res = await createFetchWebhookHandler({ secret: SECRET, onEvent: vi.fn() })(
      new Request('https://example.test/tdl', { method: 'GET' }),
    );
    expect(res.status).toBe(405);
  });

  // A 500 on an unknown event is a self-inflicted endpoint disable: the sender
  // drops an endpoint after 10 consecutive failed deliveries.
  it('returns 204 for an unrecognised event name', async () => {
    const body = ping.replace('webhook.ping', 'listing.something_new');
    const res = await createFetchWebhookHandler({ secret: SECRET, onEvent: vi.fn() })(post(body));
    expect(res.status).toBe(204);
  });

  it('returns 500 when the handler throws, so the delivery is retried', async () => {
    const onError = vi.fn();
    const res = await createFetchWebhookHandler({
      secret: SECRET,
      onEvent: () => {
        throw new Error('boom');
      },
      onError,
    })(post(ping));

    expect(res.status).toBe(500);
    expect(onError).toHaveBeenCalled();
  });

  it('returns 202 when the handler overruns its budget', async () => {
    const res = await createFetchWebhookHandler({
      secret: SECRET,
      handlerTimeoutMs: 10,
      onEvent: () => new Promise((resolve) => setTimeout(resolve, 200)),
    })(post(ping));

    expect(res.status).toBe(202);
  });
});

function nodeRequest(body: string | null, over: Record<string, unknown> = {}): IncomingMessage {
  const stream = Readable.from(body === null ? [] : [Buffer.from(body, 'utf8')]);
  return Object.assign(stream, {
    method: 'POST',
    headers: body === null ? {} : { 'x-tdl-signature': signature(body), 'x-tdl-delivery': DELIVERY },
    ...over,
  }) as unknown as IncomingMessage;
}

function nodeResponse(): ServerResponse & { done: Promise<number> } {
  let settle: (status: number) => void;
  const done = new Promise<number>((resolve) => {
    settle = resolve;
  });
  const res = {
    statusCode: 200,
    end: () => settle(res.statusCode),
    done,
  };
  return res as unknown as ServerResponse & { done: Promise<number> };
}

describe('a missing secret', () => {
  it.each(['', '   '])('stops either handler from being built: %j', (secret) => {
    expect(() => createWebhookHandler({ secret, onEvent: vi.fn() })).toThrow('secret is required');
    expect(() => createFetchWebhookHandler({ secret, onEvent: vi.fn() })).toThrow('secret is required');
  });
});

describe('createWebhookHandler', () => {
  it('reads the raw stream and returns 204', async () => {
    const onEvent = vi.fn();
    const res = nodeResponse();
    createWebhookHandler({ secret: SECRET, onEvent })(nodeRequest(ping), res);

    expect(await res.done).toBe(204);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'webhook.ping' }),
      { delivery: DELIVERY, attempt: 1 },
    );
  });

  // What express.raw({ type: 'application/json' }) leaves behind.
  it('verifies a raw Buffer body a parser already read', async () => {
    const onEvent = vi.fn();
    const res = nodeResponse();
    createWebhookHandler({ secret: SECRET, onEvent })(
      nodeRequest(null, { body: Buffer.from(ping, 'utf8'), headers: { 'x-tdl-signature': signature(ping) } }),
      res,
    );

    expect(await res.done).toBe(204);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'webhook.ping' }), expect.anything());
  });

  it('refuses an oversized raw Buffer body', async () => {
    const res = nodeResponse();
    createWebhookHandler({ secret: SECRET, onEvent: vi.fn() })(
      nodeRequest(null, { body: Buffer.alloc(MAX_BODY_BYTES + 1) }),
      res,
    );
    expect(await res.done).toBe(413);
  });

  // express.raw() with no options defaults `type` to application/octet-stream
  // and silently skips JSON, so req.body stays undefined and this path is the
  // one that fires when a JSON parser ran instead.
  it('reports BODY_CONSUMED when a body parser ran first', async () => {
    const onError = vi.fn();
    const res = nodeResponse();
    createWebhookHandler({ secret: SECRET, onEvent: vi.fn(), onError })(
      nodeRequest(ping, { body: { already: 'parsed' } }),
      res,
    );

    expect(await res.done).toBe(500);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'BODY_CONSUMED' }));
  });

  it('returns 405 for a non-POST request', async () => {
    const res = nodeResponse();
    createWebhookHandler({ secret: SECRET, onEvent: vi.fn() })(nodeRequest(null, { method: 'GET' }), res);
    expect(await res.done).toBe(405);
  });
});
