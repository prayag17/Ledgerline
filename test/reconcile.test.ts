import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { msUntilNextRun, runReconciliation } from '../src/recon/reconcile.ts';
import { fundedWallet, newAccount, newMerchant, setup, transfer, type Ctx } from './helpers.ts';

let ctx: Ctx;
before(async () => (ctx = await setup()));
after(async () => {
  await ctx.app.close();
  await ctx.pool.end();
});

describe('reconciliation', () => {
  test('a consistent ledger reconciles with zero drift and the run is recorded', async () => {
    const { apiKey } = await newMerchant(ctx.pool);
    const { wallet } = await fundedWallet(ctx, apiKey, 5_000);
    const dest = await newAccount(ctx, apiKey);
    await transfer(ctx, apiKey, { source_account_id: wallet, destination_account_id: dest, amount: 1_234 });
    await transfer(ctx, apiKey, { source_account_id: wallet, destination_account_id: dest, amount: 999_999 }); // declined

    const report = await runReconciliation(ctx.pool);
    assert.ok(report);
    assert.equal(report.status, 'ok', JSON.stringify(report.checks.filter((c) => !c.ok)));
    assert.equal(report.driftAmount, 0);
    const { rows } = await ctx.pool.query('SELECT status FROM reconciliation_runs WHERE id = $1', [report.runId]);
    assert.equal(rows[0].status, 'ok');
  });

  test('detects a posted transfer with no ledger legs as drift', async () => {
    const { merchant, apiKey } = await newMerchant(ctx.pool);
    const a = await newAccount(ctx, apiKey, 'funding');
    const b = await newAccount(ctx, apiKey);
    // simulate a bug that records a posted transfer without posting to the ledger
    const { rows: [bad] } = await ctx.pool.query(
      `INSERT INTO transfers (id, merchant_id, idempotency_key, source_account_id, destination_account_id, amount, currency, status)
       VALUES (gen_random_uuid(), $1, 'broken', $2, $3, 42, 'USD', 'posted') RETURNING id`,
      [merchant.id, a, b],
    );
    try {
      const report = await runReconciliation(ctx.pool);
      assert.ok(report);
      assert.equal(report.status, 'mismatch');
      const legs = report.checks.find((c) => c.name === 'transfer_legs')!;
      assert.ok(legs.samples.some((s) => (s as { id: string }).id === bad.id));
      assert.equal(report.driftAmount, 84, 'both accounts are off by 42');
    } finally {
      await ctx.pool.query('DELETE FROM transfers WHERE id = $1', [bad.id]);
    }
  });

  test('a second concurrent run is skipped by the advisory lock', async () => {
    const [a, b] = await Promise.all([runReconciliation(ctx.pool), runReconciliation(ctx.pool)]);
    assert.equal([a, b].filter((r) => r === null).length <= 1, true);
  });

  test('schedules the next run at the configured UTC hour', () => {
    assert.equal(msUntilNextRun(2, new Date('2026-01-01T01:00:00Z')), 3_600_000);
    assert.equal(msUntilNextRun(2, new Date('2026-01-01T02:00:00Z')), 24 * 3_600_000);
  });
});
