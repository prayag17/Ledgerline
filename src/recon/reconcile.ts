import { config } from '../config.ts';
import type { Pool } from '../db.ts';

const RECON_LOCK_KEY = 4242001;

export type CheckResult = { name: string; ok: boolean; count: number; samples: unknown[] };

export type ReconciliationReport = {
  runId: number;
  status: 'ok' | 'mismatch';
  checkedAt: string;
  totals: { transfers: number; postedTransfers: number; ledgerEntries: number; accounts: number };
  checks: CheckResult[];
  /** sum of |ledger balance - balance implied by transfers| over all accounts, in minor units */
  driftAmount: number;
  warnings: Record<string, number>;
};

async function check(client: { query: Pool['query'] }, name: string, sql: string): Promise<CheckResult> {
  const { rows } = await client.query(sql);
  return { name, ok: rows.length === 0, count: rows.length, samples: rows.slice(0, 20) };
}

/**
 * Verifies the ledger against itself and against the transfers table. All checks read one REPEATABLE READ
 * snapshot, so traffic committing while the job runs cannot produce false mismatches.
 */
export async function runReconciliation(pool: Pool): Promise<ReconciliationReport | null> {
  const lockClient = await pool.connect();
  try {
    const { rows: [lock] } = await lockClient.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [RECON_LOCK_KEY]);
    if (!lock?.ok) return null; // another instance is already reconciling
    try {
      return await reconcile(pool);
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [RECON_LOCK_KEY]);
    }
  } finally {
    lockClient.release();
  }
}

async function reconcile(pool: Pool): Promise<ReconciliationReport> {
  const { rows: [run] } = await pool.query<{ id: number }>(
    `INSERT INTO reconciliation_runs (status) VALUES ('running') RETURNING id`,
  );
  const runId = run!.id;
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');

    const checks: CheckResult[] = [];

    // 1. every posted transfer has exactly one debit on its source and one credit on its destination for
    //    its full amount; declined transfers have no legs at all.
    checks.push(
      await check(
        c,
        'transfer_legs',
        `WITH legs AS (
           SELECT e.transfer_id, count(*) AS n,
                  sum(e.amount) FILTER (WHERE e.direction = 'debit') AS debit_total,
                  sum(e.amount) FILTER (WHERE e.direction = 'credit') AS credit_total,
                  bool_and(e.direction <> 'debit' OR e.account_id = t.source_account_id) AS debit_ok,
                  bool_and(e.direction <> 'credit' OR e.account_id = t.destination_account_id) AS credit_ok
             FROM ledger_entries e JOIN transfers t ON t.id = e.transfer_id
            GROUP BY e.transfer_id)
         SELECT t.id, t.status, t.amount, l.n, l.debit_total, l.credit_total
           FROM transfers t LEFT JOIN legs l ON l.transfer_id = t.id
          WHERE (t.status = 'posted' AND (l.n IS DISTINCT FROM 2
                                          OR l.debit_total IS DISTINCT FROM t.amount
                                          OR l.credit_total IS DISTINCT FROM t.amount
                                          OR NOT l.debit_ok OR NOT l.credit_ok))
             OR (t.status <> 'posted' AND l.transfer_id IS NOT NULL)`,
      ),
    );

    // 2. double-entry invariant: total debits equal total credits in every currency.
    checks.push(
      await check(
        c,
        'trial_balance',
        `SELECT currency,
                sum(amount) FILTER (WHERE direction = 'debit')::bigint AS debits,
                sum(amount) FILTER (WHERE direction = 'credit')::bigint AS credits
           FROM ledger_entries GROUP BY currency
          HAVING sum(amount) FILTER (WHERE direction = 'debit') IS DISTINCT FROM sum(amount) FILTER (WHERE direction = 'credit')`,
      ),
    );

    // 3. per-account drift: balance derived from ledger entries vs. balance implied by posted transfers.
    const driftSql = `
      WITH ledger AS (
        SELECT account_id, sum(CASE WHEN direction = 'credit' THEN amount ELSE -amount END)::bigint AS balance
          FROM ledger_entries GROUP BY account_id),
      implied AS (
        SELECT account_id, sum(delta)::bigint AS balance FROM (
          SELECT destination_account_id AS account_id, amount AS delta FROM transfers WHERE status = 'posted'
          UNION ALL
          SELECT source_account_id, -amount FROM transfers WHERE status = 'posted') s
         GROUP BY account_id)
      SELECT account_id, coalesce(l.balance, 0) AS ledger_balance, coalesce(i.balance, 0) AS implied_balance
        FROM ledger l FULL JOIN implied i USING (account_id)
       WHERE coalesce(l.balance, 0) <> coalesce(i.balance, 0)`;
    const drift = await check(c, 'account_drift', driftSql);
    checks.push(drift);
    const driftAmount = (drift.samples as { ledger_balance: number; implied_balance: number }[]).length
      ? Number(
          (
            await c.query<{ total: number }>(
              `SELECT coalesce(sum(abs(ledger_balance - implied_balance)), 0)::bigint AS total FROM (${driftSql}) d`,
            )
          ).rows[0]!.total,
        )
      : 0;

    // 4. non-funding accounts never go negative.
    checks.push(
      await check(
        c,
        'negative_balances',
        `SELECT a.id, sum(CASE WHEN e.direction = 'credit' THEN e.amount ELSE -e.amount END)::bigint AS balance
           FROM accounts a JOIN ledger_entries e ON e.account_id = a.id
          WHERE NOT a.allow_negative
          GROUP BY a.id
         HAVING sum(CASE WHEN e.direction = 'credit' THEN e.amount ELSE -e.amount END) < 0`,
      ),
    );

    // 5. every transfer that reached a final state is referenced by exactly one idempotency record or none
    //    (keys expire), never by two.
    checks.push(
      await check(
        c,
        'duplicate_idempotency_refs',
        `SELECT transfer_id, count(*) FROM idempotency_keys WHERE transfer_id IS NOT NULL
          GROUP BY transfer_id HAVING count(*) > 1`,
      ),
    );

    const { rows: [totals] } = await c.query<{
      transfers: number;
      posted: number;
      entries: number;
      accounts: number;
      dead_webhooks: number;
      stale_webhooks: number;
    }>(
      `SELECT (SELECT count(*) FROM transfers) AS transfers,
              (SELECT count(*) FROM transfers WHERE status = 'posted') AS posted,
              (SELECT count(*) FROM ledger_entries) AS entries,
              (SELECT count(*) FROM accounts) AS accounts,
              (SELECT count(*) FROM outbox_events WHERE status = 'dead') AS dead_webhooks,
              (SELECT count(*) FROM outbox_events WHERE status = 'pending' AND created_at < now() - interval '1 hour') AS stale_webhooks`,
    );
    await c.query('COMMIT');

    const report: ReconciliationReport = {
      runId,
      status: checks.every((x) => x.ok) ? 'ok' : 'mismatch',
      checkedAt: new Date().toISOString(),
      totals: {
        transfers: totals!.transfers,
        postedTransfers: totals!.posted,
        ledgerEntries: totals!.entries,
        accounts: totals!.accounts,
      },
      checks,
      driftAmount,
      warnings: { deadWebhooks: totals!.dead_webhooks, staleWebhooks: totals!.stale_webhooks },
    };
    await pool.query(`UPDATE reconciliation_runs SET status = $2, finished_at = now(), summary = $3 WHERE id = $1`, [
      runId,
      report.status,
      report,
    ]);
    return report;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    await pool.query(
      `UPDATE reconciliation_runs SET status = 'error', finished_at = now(), summary = $2 WHERE id = $1`,
      [runId, { error: String(err) }],
    );
    throw err;
  } finally {
    c.release();
  }
}

/** Housekeeping that runs with the nightly job: idempotency keys are honoured for IDEMPOTENCY_TTL_HOURS. */
export async function expireIdempotencyKeys(pool: Pool, ttlHours = config.idempotencyTtlHours): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM idempotency_keys WHERE created_at < now() - make_interval(hours => $1)`,
    [ttlHours],
  );
  return rowCount ?? 0;
}

export function msUntilNextRun(hourUtc: number, now = new Date()): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

/** Runs reconciliation every night at RECON_HOUR_UTC. Safe to start in several processes (advisory lock). */
export function scheduleNightlyReconciliation(pool: Pool, hourUtc = config.recon.hourUtc): () => void {
  let timer: NodeJS.Timeout;
  const arm = () => {
    timer = setTimeout(async () => {
      try {
        const report = await runReconciliation(pool);
        if (report) {
          const log = report.status === 'ok' ? console.log : console.error;
          log(`reconciliation run ${report.runId}: ${report.status} (drift ${report.driftAmount})`);
        }
        const expired = await expireIdempotencyKeys(pool);
        if (expired) console.log(`expired ${expired} idempotency keys`);
      } catch (err) {
        console.error('nightly reconciliation failed', err);
      } finally {
        arm();
      }
    }, msUntilNextRun(hourUtc));
    timer.unref();
  };
  arm();
  return () => clearTimeout(timer);
}
