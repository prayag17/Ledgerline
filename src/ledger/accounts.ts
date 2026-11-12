import type { Pool } from '../db.ts';

type AccountRow = {
  id: string;
  name: string;
  currency: string;
  kind: 'wallet' | 'funding';
  created_at: Date;
  balance: number;
};

function serializeAccount(r: AccountRow) {
  return {
    id: r.id,
    object: 'account',
    name: r.name,
    currency: r.currency,
    kind: r.kind,
    balance: r.balance,
    created_at: r.created_at.toISOString(),
  };
}

const BALANCE_SQL = `coalesce((SELECT sum(CASE WHEN e.direction = 'credit' THEN e.amount ELSE -e.amount END)
                                FROM ledger_entries e WHERE e.account_id = a.id), 0)::bigint`;

export async function createAccount(
  pool: Pool,
  merchantId: string,
  input: { name: string; currency: string; kind: 'wallet' | 'funding' },
) {
  const { rows } = await pool.query<AccountRow>(
    `INSERT INTO accounts (merchant_id, name, currency, kind) VALUES ($1, $2, $3, $4)
     RETURNING id, name, currency, kind, created_at, 0::bigint AS balance`,
    [merchantId, input.name, input.currency, input.kind],
  );
  return serializeAccount(rows[0]!);
}

/** Balance is always derived from the ledger; there is no stored balance column to drift. */
export async function getAccount(pool: Pool, merchantId: string, id: string) {
  const { rows } = await pool.query<AccountRow>(
    `SELECT a.id, a.name, a.currency, a.kind, a.created_at, ${BALANCE_SQL} AS balance
       FROM accounts a WHERE a.id = $1 AND a.merchant_id = $2`,
    [id, merchantId],
  );
  return rows[0] ? serializeAccount(rows[0]) : null;
}

export async function listEntries(pool: Pool, merchantId: string, accountId: string, limit: number, before?: number) {
  const { rows } = await pool.query<{
    id: number;
    transfer_id: string;
    direction: string;
    amount: number;
    currency: string;
    created_at: Date;
  }>(
    `SELECT e.id, e.transfer_id, e.direction, e.amount, e.currency, e.created_at
       FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
      WHERE e.account_id = $1 AND a.merchant_id = $2 AND ($3::bigint IS NULL OR e.id < $3)
      ORDER BY e.id DESC LIMIT $4`,
    [accountId, merchantId, before ?? null, limit],
  );
  return rows.map((r) => ({ object: 'ledger_entry', ...r, created_at: r.created_at.toISOString() }));
}
