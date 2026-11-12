// Seeds a merchant with one funding account and N funded wallets, then writes loadtest/fixtures.json.
//   node src/scripts/seed.ts --wallets 2000 --balance 100000000 --webhook-url http://localhost:4000/webhooks
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createPool, withTransaction } from '../db.ts';
import { createMerchant } from '../ledger/merchants.ts';

const { values } = parseArgs({
  options: {
    wallets: { type: 'string', default: '2000' },
    balance: { type: 'string', default: '100000000' },
    currency: { type: 'string', default: 'USD' },
    'webhook-url': { type: 'string' },
    'max-transfer': { type: 'string', default: '100000' },
    'daily-limit': { type: 'string', default: '50000000' },
    'velocity-max': { type: 'string', default: '200' },
    'velocity-window': { type: 'string', default: '60' },
    'base-url': { type: 'string', default: 'http://localhost:3000' },
    out: { type: 'string', default: 'loadtest/fixtures.json' },
  },
});

const wallets = Number(values.wallets);
const balance = Number(values.balance);
const currency = values.currency;
const pool = createPool(undefined, 4);

try {
  const { merchant, apiKey, webhookSecret } = await createMerchant(pool, {
    name: `loadtest-${new Date().toISOString()}`,
    webhookUrl: values['webhook-url'] ?? null,
    limits: {
      maxTransferAmount: Number(values['max-transfer']),
      dailyLimitAmount: Number(values['daily-limit']),
      velocityMaxCount: Number(values['velocity-max']),
      velocityWindowSeconds: Number(values['velocity-window']),
    },
  });

  const walletIds = await withTransaction(pool, async (c) => {
    const { rows: [funding] } = await c.query<{ id: string }>(
      `INSERT INTO accounts (merchant_id, name, currency, kind) VALUES ($1, 'funding', $2, 'funding') RETURNING id`,
      [merchant.id, currency],
    );
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO accounts (merchant_id, name, currency, kind)
       SELECT $1, 'wallet-' || g, $2, 'wallet' FROM generate_series(1, $3) g RETURNING id`,
      [merchant.id, currency, wallets],
    );
    const ids = rows.map((r) => r.id);
    const transferIds = ids.map(() => randomUUID());
    // fund every wallet from the funding account with a normal balanced double-entry transfer
    await c.query(
      `WITH t AS (
         INSERT INTO transfers (id, merchant_id, idempotency_key, source_account_id, destination_account_id,
                                amount, currency, status, description)
         SELECT tid, $1, 'seed-' || tid, $2, wid, $3, $4, 'posted', 'initial funding'
           FROM unnest($5::uuid[], $6::uuid[]) AS u(tid, wid)
         RETURNING id, source_account_id, destination_account_id, amount, currency)
       INSERT INTO ledger_entries (transfer_id, account_id, direction, amount, currency)
       SELECT id, source_account_id, 'debit', amount, currency FROM t
       UNION ALL
       SELECT id, destination_account_id, 'credit', amount, currency FROM t`,
      [merchant.id, funding!.id, balance, currency, transferIds, ids],
    );
    return ids;
  });

  await writeFile(
    values.out,
    JSON.stringify(
      { baseUrl: values['base-url'], merchantId: merchant.id, apiKey, webhookSecret, currency, wallets: walletIds },
      null,
      2,
    ),
  );
  console.log(`seeded merchant ${merchant.id} with ${wallets} wallets of ${balance} ${currency}; wrote ${values.out}`);
} finally {
  await pool.end();
}
