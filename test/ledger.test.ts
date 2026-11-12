import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { withTransaction } from '../src/db.ts';
import { balance, fundedWallet, newAccount, newMerchant, setup, transfer, type Ctx } from './helpers.ts';

let ctx: Ctx;
before(async () => (ctx = await setup()));
after(async () => {
  await ctx.app.close();
  await ctx.pool.end();
});

describe('double-entry ledger', () => {
  test('a transfer posts one debit and one credit and balances are derived from the ledger', async () => {
    const { apiKey } = await newMerchant(ctx.pool);
    const { funding, wallet } = await fundedWallet(ctx, apiKey, 10_000);
    const other = await newAccount(ctx, apiKey);

    const res = await transfer(ctx, apiKey, { source_account_id: wallet, destination_account_id: other, amount: 2_500 });
    assert.equal(res.statusCode, 201);
    const t = res.json();
    assert.equal(t.status, 'posted');

    const { rows } = await ctx.pool.query(
      `SELECT account_id, direction, amount FROM ledger_entries WHERE transfer_id = $1 ORDER BY direction`,
      [t.id],
    );
    assert.deepEqual(rows, [
      { account_id: other, direction: 'credit', amount: 2_500 },
      { account_id: wallet, direction: 'debit', amount: 2_500 },
    ]);
    assert.equal(await balance(ctx, apiKey, wallet), 7_500);
    assert.equal(await balance(ctx, apiKey, other), 2_500);
    assert.equal(await balance(ctx, apiKey, funding), -10_000);
  });

  test('the database rejects an unbalanced transfer at commit', async () => {
    const { merchant, apiKey } = await newMerchant(ctx.pool);
    const a = await newAccount(ctx, apiKey);
    const b = await newAccount(ctx, apiKey);
    await assert.rejects(
      withTransaction(ctx.pool, async (c) => {
        const id = randomUUID();
        await c.query(
          `INSERT INTO transfers (id, merchant_id, idempotency_key, source_account_id, destination_account_id, amount, currency, status)
           VALUES ($1, $2, $3, $4, $5, 100, 'USD', 'posted')`,
          [id, merchant.id, randomUUID(), a, b],
        );
        await c.query(
          `INSERT INTO ledger_entries (transfer_id, account_id, direction, amount, currency) VALUES
             ($1, $2, 'debit', 100, 'USD'), ($1, $3, 'credit', 99, 'USD')`,
          [id, a, b],
        );
      }),
      /unbalanced transfer/,
    );
  });

  test('ledger entries are append-only', async () => {
    await assert.rejects(ctx.pool.query(`UPDATE ledger_entries SET amount = amount + 1`), /append-only/);
    await assert.rejects(ctx.pool.query(`DELETE FROM ledger_entries`), /append-only/);
  });

  test('concurrent debits never overdraw a wallet', async () => {
    const { apiKey } = await newMerchant(ctx.pool);
    const { wallet } = await fundedWallet(ctx, apiKey, 1_000);
    const sink = await newAccount(ctx, apiKey);
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        transfer(ctx, apiKey, { source_account_id: wallet, destination_account_id: sink, amount: 100 }),
      ),
    );
    const posted = results.filter((r) => r.statusCode === 201).length;
    const declined = results.filter((r) => r.statusCode === 402);
    assert.equal(posted, 10);
    assert.equal(declined.length, 20);
    assert.ok(declined.every((r) => r.json().decline_reason === 'insufficient_funds'));
    assert.equal(await balance(ctx, apiKey, wallet), 0);
    assert.equal(await balance(ctx, apiKey, sink), 1_000);
  });

  test('opposite-direction transfers between two accounts do not deadlock', async () => {
    const { apiKey } = await newMerchant(ctx.pool);
    const { funding, wallet: a } = await fundedWallet(ctx, apiKey, 100_000);
    const b = await newAccount(ctx, apiKey);
    await transfer(ctx, apiKey, { source_account_id: funding, destination_account_id: b, amount: 100_000 });
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        transfer(ctx, apiKey, {
          source_account_id: i % 2 ? a : b,
          destination_account_id: i % 2 ? b : a,
          amount: 10,
        }),
      ),
    );
    assert.deepEqual(new Set(results.map((r) => r.statusCode)), new Set([201]));
    assert.equal((await balance(ctx, apiKey, a)) + (await balance(ctx, apiKey, b)), 200_000);
  });

  test('rejects currency mismatches, unknown accounts and same-account transfers without storing a result', async () => {
    const { apiKey } = await newMerchant(ctx.pool);
    const usd = await newAccount(ctx, apiKey, 'funding', 'USD');
    const eur = await newAccount(ctx, apiKey, 'wallet', 'EUR');
    let res = await transfer(ctx, apiKey, { source_account_id: usd, destination_account_id: eur, amount: 1 });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error.code, 'currency_mismatch');

    res = await transfer(ctx, apiKey, { source_account_id: usd, destination_account_id: randomUUID(), amount: 1 });
    assert.equal(res.statusCode, 404);

    res = await transfer(ctx, apiKey, { source_account_id: usd, destination_account_id: usd, amount: 1 });
    assert.equal(res.statusCode, 400);

    res = await transfer(ctx, apiKey, { source_account_id: usd, destination_account_id: eur, amount: '5' as unknown as number });
    assert.equal(res.statusCode, 400, 'string amounts are not coerced');
  });

  test("a merchant cannot touch another merchant's accounts", async () => {
    const m1 = await newMerchant(ctx.pool);
    const m2 = await newMerchant(ctx.pool);
    const { wallet } = await fundedWallet(ctx, m1.apiKey, 1_000);
    const theirs = await newAccount(ctx, m2.apiKey);
    const res = await transfer(ctx, m2.apiKey, { source_account_id: wallet, destination_account_id: theirs, amount: 1 });
    assert.equal(res.statusCode, 404);
    const get = await ctx.app.inject({ method: 'GET', url: `/v1/accounts/${wallet}`, headers: m2.auth });
    assert.equal(get.statusCode, 404);
  });
});
