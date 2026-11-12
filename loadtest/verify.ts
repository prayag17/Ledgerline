// Post-load-test verification: compares what k6 observed with what the database holds, then runs the full
// reconciliation. Exits non-zero on any discrepancy.
//   node loadtest/verify.ts loadtest/results/rate-1000.json [more result files ...]
import { readFileSync } from 'node:fs';
import { createPool } from '../src/db.ts';
import { runReconciliation } from '../src/recon/reconcile.ts';

const fixtures = JSON.parse(readFileSync('loadtest/fixtures.json', 'utf8'));
const results = process.argv.slice(2).map((f) => JSON.parse(readFileSync(f, 'utf8')));
const expectedPosted = results.reduce((s, r) => s + r.transfers_posted, 0);
const expectedDeclined = results.reduce((s, r) => s + r.transfers_declined, 0);

const pool = createPool(undefined, 3);
try {
  const { rows: [db] } = await pool.query<{ posted: number; declined: number; keys: number; distinct_keys: number }>(
    `SELECT count(*) FILTER (WHERE status = 'posted') AS posted,
            count(*) FILTER (WHERE status = 'declined') AS declined,
            count(*) AS keys,
            count(DISTINCT idempotency_key) AS distinct_keys
       FROM transfers WHERE merchant_id = $1 AND idempotency_key NOT LIKE 'seed-%'`,
    [fixtures.merchantId],
  );
  const { rows: [sum] } = await pool.query<{ total: number; wallets: number }>(
    `SELECT coalesce(sum(CASE WHEN e.direction = 'credit' THEN e.amount ELSE -e.amount END), 0)::bigint AS total,
            count(DISTINCT a.id) AS wallets
       FROM accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
      WHERE a.merchant_id = $1`,
    [fixtures.merchantId],
  );
  const report = await runReconciliation(pool);

  const checks = {
    'k6 201s == posted transfers in DB': [expectedPosted, db!.posted],
    'k6 402s == declined transfers in DB': [expectedDeclined, db!.declined],
    'one transfer per idempotency key': [db!.keys, db!.distinct_keys],
    "sum of all of the merchant's balances is zero": [0, sum!.total],
    'reconciliation drift (minor units)': [0, report?.driftAmount ?? -1],
    'reconciliation status': ['ok', report?.status ?? 'locked'],
  } as const;
  let ok = true;
  for (const [name, [want, got]] of Object.entries(checks)) {
    const pass = want === got;
    ok &&= pass;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: expected ${want}, got ${got}`);
  }
  if (report) {
    console.log(
      `reconciled ${report.totals.transfers} transfers / ${report.totals.ledgerEntries} ledger entries across ${report.totals.accounts} accounts`,
    );
    for (const c of report.checks) console.log(`  ${c.ok ? 'ok      ' : 'MISMATCH'} ${c.name} (${c.count})`);
  }
  process.exitCode = ok ? 0 : 1;
} finally {
  await pool.end();
}
