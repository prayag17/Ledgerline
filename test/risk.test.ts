import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { evaluateRisk } from '../src/ledger/risk.ts';
import { fundedWallet, newAccount, newMerchant, setup, transfer, type Ctx } from './helpers.ts';

const limits = { maxTransferAmount: 1_000, dailyLimitAmount: 5_000, velocityMaxCount: 3, velocityWindowSeconds: 60 };
const base = { amount: 100, recentCount: 0, trailingDayAmount: 0, balance: 10_000, allowNegative: false };

describe('evaluateRisk', () => {
  test('passes a normal transfer', () => assert.equal(evaluateRisk(base, limits), null));
  test('per-transfer amount limit', () =>
    assert.equal(evaluateRisk({ ...base, amount: 1_001 }, limits), 'amount_limit_exceeded'));
  test('trailing 24h limit', () =>
    assert.equal(evaluateRisk({ ...base, trailingDayAmount: 4_950 }, limits), 'daily_limit_exceeded'));
  test('velocity limit', () => assert.equal(evaluateRisk({ ...base, recentCount: 3 }, limits), 'velocity_limit_exceeded'));
  test('insufficient funds', () => assert.equal(evaluateRisk({ ...base, balance: 99 }, limits), 'insufficient_funds'));
  test('funding accounts may go negative', () =>
    assert.equal(evaluateRisk({ ...base, balance: -5_000, allowNegative: true }, limits), null));
});

let ctx: Ctx;
before(async () => (ctx = await setup()));
after(async () => {
  await ctx.app.close();
  await ctx.pool.end();
});

describe('risk checks over HTTP', () => {
  test('velocity limit declines the fourth transfer in the window', async () => {
    const { apiKey } = await newMerchant(ctx.pool, { limits: { velocityMaxCount: 3 } });
    const { wallet } = await fundedWallet(ctx, apiKey, 10_000);
    const dest = await newAccount(ctx, apiKey);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      codes.push((await transfer(ctx, apiKey, { source_account_id: wallet, destination_account_id: dest, amount: 10 })).statusCode);
    }
    assert.deepEqual(codes, [201, 201, 201, 402]);
  });

  test('amount limit declines with a reason and posts no ledger entries', async () => {
    const { apiKey } = await newMerchant(ctx.pool, { limits: { maxTransferAmount: 500 } });
    const { wallet } = await fundedWallet(ctx, apiKey, 400);
    const dest = await newAccount(ctx, apiKey);
    const res = await transfer(ctx, apiKey, { source_account_id: wallet, destination_account_id: dest, amount: 501 });
    assert.equal(res.statusCode, 402);
    assert.equal(res.json().decline_reason, 'amount_limit_exceeded');
    const { rows } = await ctx.pool.query('SELECT count(*) AS n FROM ledger_entries WHERE transfer_id = $1', [res.json().id]);
    assert.equal(rows[0].n, 0);
  });

  test('daily limit counts what was already sent', async () => {
    const { apiKey } = await newMerchant(ctx.pool, { limits: { maxTransferAmount: 1_000, dailyLimitAmount: 1_500 } });
    const { wallet, funding } = await fundedWallet(ctx, apiKey, 700);
    await transfer(ctx, apiKey, { source_account_id: funding, destination_account_id: wallet, amount: 700 });
    const dest = await newAccount(ctx, apiKey);
    assert.equal((await transfer(ctx, apiKey, { source_account_id: wallet, destination_account_id: dest, amount: 1_000 })).statusCode, 201);
    const res = await transfer(ctx, apiKey, { source_account_id: wallet, destination_account_id: dest, amount: 400 });
    assert.equal(res.statusCode, 201);
    const again = await transfer(ctx, apiKey, { source_account_id: dest, destination_account_id: wallet, amount: 200 });
    assert.equal(again.statusCode, 201, 'limits are per source account');
    const over = await transfer(ctx, apiKey, { source_account_id: wallet, destination_account_id: dest, amount: 150 });
    assert.equal(over.json().decline_reason, 'daily_limit_exceeded');
  });
});
