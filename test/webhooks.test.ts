import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { backoffDelayMs, OutboxDispatcher } from '../src/outbox/dispatcher.ts';
import { SIGNATURE_HEADER, signPayload, verifySignature } from '../src/outbox/signature.ts';
import { fundedWallet, newAccount, newMerchant, setup, transfer, type Ctx } from './helpers.ts';

describe('webhook signatures', () => {
  const secret = 'whsec_test';
  const body = '{"id":"evt_1"}';
  test('round-trips', () => assert.ok(verifySignature(secret, body, signPayload(secret, body))));
  test('rejects a tampered body', () => assert.ok(!verifySignature(secret, body + ' ', signPayload(secret, body))));
  test('rejects the wrong secret', () => assert.ok(!verifySignature('whsec_other', body, signPayload(secret, body))));
  test('rejects stale timestamps (replay protection)', () => {
    const header = signPayload(secret, body, 1_000);
    assert.ok(!verifySignature(secret, body, header, { now: 1_000 + 301 }));
    assert.ok(verifySignature(secret, body, header, { now: 1_000 + 299 }));
  });
  test('accepts any matching v1 during secret rotation', () => {
    const header = signPayload(secret, body, 5) + ',v1=' + 'ab'.repeat(32);
    assert.ok(verifySignature(secret, body, header, { now: 5 }));
  });
  test('rejects garbage', () => {
    assert.ok(!verifySignature(secret, body, undefined));
    assert.ok(!verifySignature(secret, body, 't=abc,v1=zz'));
  });
});

describe('backoff', () => {
  test('doubles per attempt within [d/2, d] and caps', () => {
    assert.equal(backoffDelayMs(1, 1000, 60_000, () => 1), 1000);
    assert.equal(backoffDelayMs(1, 1000, 60_000, () => 0), 500);
    assert.equal(backoffDelayMs(4, 1000, 60_000, () => 1), 8000);
    assert.equal(backoffDelayMs(20, 1000, 60_000, () => 1), 60_000);
  });
});

type Received = { headers: IncomingMessage['headers']; body: string };

describe('outbox dispatcher', () => {
  let ctx: Ctx;
  let server: Server;
  let url: string;
  const received: Received[] = [];
  let failNext = 0;

  before(async () => {
    ctx = await setup();
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        if (failNext > 0) {
          failNext--;
          res.writeHead(503).end();
        } else res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`;
  });
  after(async () => {
    server.close();
    await ctx.app.close();
    await ctx.pool.end();
  });

  test('a transfer and its webhook event commit atomically, and delivery is signed', async () => {
    const { merchant, apiKey, webhookSecret } = await newMerchant(ctx.pool, { webhookUrl: url });
    const { wallet } = await fundedWallet(ctx, apiKey, 1_000);
    const dest = await newAccount(ctx, apiKey);
    const t = (await transfer(ctx, apiKey, { source_account_id: wallet, destination_account_id: dest, amount: 250 })).json();

    const { rows } = await ctx.pool.query(`SELECT event_type, status FROM outbox_events WHERE transfer_id = $1`, [t.id]);
    assert.deepEqual(rows, [{ event_type: 'transfer.posted', status: 'pending' }]);

    received.length = 0;
    const dispatcher = new OutboxDispatcher(ctx.pool, { batchSize: 1000 });
    while ((await dispatcher.runOnce()) > 0);
    const mine = received.filter((r) => JSON.parse(r.body).data.object.id === t.id);
    assert.equal(mine.length, 1);
    const hook = mine[0]!;
    assert.ok(verifySignature(webhookSecret, hook.body, hook.headers[SIGNATURE_HEADER] as string));
    assert.equal(JSON.parse(hook.body).type, 'transfer.posted');
    assert.equal(hook.headers['ledgerline-event-type'], 'transfer.posted');

    const { rows: [ev] } = await ctx.pool.query(
      `SELECT status, attempts FROM outbox_events WHERE transfer_id = $1 AND merchant_id = $2`,
      [t.id, merchant.id],
    );
    assert.deepEqual(ev, { status: 'delivered', attempts: 1 });
  });

  test('failed deliveries are retried with backoff and give up after max attempts', async () => {
    const { apiKey } = await newMerchant(ctx.pool, { webhookUrl: url });
    const funding = await newAccount(ctx, apiKey, 'funding');
    const dest = await newAccount(ctx, apiKey);
    const t = (await transfer(ctx, apiKey, { source_account_id: funding, destination_account_id: dest, amount: 5 })).json();
    // park every other pending event so only this one is due
    await ctx.pool.query(`UPDATE outbox_events SET next_attempt_at = now() + interval '1 day' WHERE transfer_id <> $1 AND status = 'pending'`, [t.id]);

    failNext = 1;
    const dispatcher = new OutboxDispatcher(ctx.pool, { baseDelayMs: 60_000, maxAttempts: 3 });
    assert.equal(await dispatcher.runOnce(), 1);
    let { rows: [ev] } = await ctx.pool.query(
      `SELECT status, attempts, last_response_status, next_attempt_at > now() + interval '25 seconds' AS backed_off
         FROM outbox_events WHERE transfer_id = $1`,
      [t.id],
    );
    assert.deepEqual(ev, { status: 'pending', attempts: 1, last_response_status: 503, backed_off: true });
    assert.equal(await dispatcher.runOnce(), 0, 'not due yet');

    failNext = 10;
    for (let i = 0; i < 2; i++) {
      await ctx.pool.query(`UPDATE outbox_events SET next_attempt_at = now() WHERE transfer_id = $1`, [t.id]);
      await dispatcher.runOnce();
    }
    ({ rows: [ev] } = await ctx.pool.query(`SELECT status, attempts FROM outbox_events WHERE transfer_id = $1`, [t.id]));
    assert.deepEqual(ev, { status: 'dead', attempts: 3 });
    failNext = 0;
  });

  test('no outbox event when the merchant has no webhook url', async () => {
    const { apiKey } = await newMerchant(ctx.pool);
    const { wallet } = await fundedWallet(ctx, apiKey, 100);
    const dest = await newAccount(ctx, apiKey);
    const t = (await transfer(ctx, apiKey, { source_account_id: wallet, destination_account_id: dest, amount: 1 })).json();
    const { rows } = await ctx.pool.query(`SELECT 1 FROM outbox_events WHERE transfer_id = $1`, [t.id]);
    assert.equal(rows.length, 0);
  });
});
