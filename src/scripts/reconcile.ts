// Runs the reconciliation job once and exits non-zero on any mismatch.
import { createPool } from '../db.ts';
import { runReconciliation } from '../recon/reconcile.ts';

const pool = createPool(undefined, 3);
try {
  const report = await runReconciliation(pool);
  if (!report) {
    console.error('another reconciliation run holds the lock; try again later');
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'ok') process.exitCode = 1;
  }
} finally {
  await pool.end();
}
