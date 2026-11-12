import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { balance, fundedWallet, newAccount, newMerchant, setup, transfer, type Ctx } from './helpers.ts';

let ctx: Ctx;
before(async () => (ctx = await setup()));
after(async () => {
  await ctx.app.close();
  await ctx.pool.end();
});

describe('idempotency keys', () => {
  test('a retried request returns the stored response and charges once', async () => {
    const { apiKey } = await newMerchant(ctx.pool);
    const { wallet } = await fundedWallet(ctx, apiKey, 10_000);
    const dest = await newAccount(ctx, apiKey);
    const key = randomUUID();
    const body = { source_account_id: wallet, destination_account_id: dest, amount: 700 };

    const first = await transfer(ctx, apiKey, body, key);
    const second = await transfer(ctx, apiKey, body, key);
    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    assert.equal(second.headers['idempotent-replayed'], 'true');
    assert.deepEqual(second.json(), first.json());
    assert.equal(await balance(ctx, apiKey, wallet), 9_300);
  });

  test('concurrent duplicates race to one transfer', async () => {
    const { merchant, apiKey } = await newMerchant(ctx.pool);
    const { wallet } = await fundedWallet(ctx, apiKey, 10_000);
    const dest = await newAccount(ctx, apiKey);
    const key = randomUUID();
    const body = { source_account_id: wallet, destination_account_id: dest, amount: 1_000 };

    const results = await Promise.all(Array.from({ length: 25 }, () => transfer(ctx, apiKey, body, key)));
    assert.ok(results.every((r) => r.statusCode === 201));
    assert.equal(new Set(results.map((r) => r.json().id)).size, 1);
    assert.equal(results.filter((r) => r.headers['idempotent-replayed'] !== 'true').length, 1);
    const { rows } = await ctx.pool.query('SELECT count(*) AS n FROM transfers WHERE merchant_id = $1 AND idempotency_key = $2', [
      merchant.id,
      key,
    ]);
    assert.equal(rows[0].n, 1);
    assert.equal(await balance(ctx, apiKey, wallet), 9_000);
  });

  test('reusing a key with a different request is rejected', async () => {
    const { apiKey } = await newMerchant(ctx.pool);
    const { wallet } = await fundedWallet(ctx, apiKey, 10_000);
    const dest = await newAccount(ctx, apiKey);
    const key = randomUUID();
    await transfer(ctx, apiKey, { source_account_id: wallet, destination_account_id: dest, amount: 100 }, key);
    const res = await transfer(ctx, apiKey, { source_account_id: wallet, destination_account_id: dest, amount: 101 }, key);
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error.code, 'idempotency_key_reused');
  });

  test('declines are stored too, so a retry does not re-run risk checks', async () => {
    const { apiKey } = await newMerchant(ctx.pool);
    const { wallet, funding } = await fundedWallet(ctx, apiKey, 50);
    const dest = await newAccount(ctx, apiKey);
    const key = randomUUID();
    const body = { source_account_id: wallet, destination_account_id: dest, amount: 100 };
    const first = await transfer(ctx, apiKey, body, key);
    assert.equal(first.statusCode, 402);
    // top up so the same request would now succeed if it were re-executed
    await transfer(ctx, apiKey, { source_account_id: funding, destination_account_id: wallet, amount: 1_000 });
    const retry = await transfer(ctx, apiKey, body, key);
    assert.equal(retry.statusCode, 402);
    assert.deepEqual(retry.json(), first.json());
  });

  test('failed requests do not burn the key', async () => {
    const { apiKey } = await newMerchant(ctx.pool);
    const funding = await newAccount(ctx, apiKey, 'funding');
    const key = randomUUID();
    const missing = randomUUID();
    const res = await transfer(ctx, apiKey, { source_account_id: funding, destination_account_id: missing, amount: 1 }, key);
    assert.equal(res.statusCode, 404);
    const dest = await newAccount(ctx, apiKey);
    const ok = await transfer(ctx, apiKey, { source_account_id: funding, destination_account_id: dest, amount: 1 }, key);
    assert.equal(ok.statusCode, 201);
  });

  test('the idempotency-key header is required', async () => {
    const { apiKey } = await newMerchant(ctx.pool);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { source_account_id: randomUUID(), destination_account_id: randomUUID(), amount: 1, currency: 'USD' },
    });
    assert.equal(res.statusCode, 400);
  });
});
