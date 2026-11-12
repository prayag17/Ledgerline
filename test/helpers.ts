import { randomUUID } from 'node:crypto';
import { createPool, type Pool } from '../src/db.ts';
import { buildApp } from '../src/http/app.ts';
import { createMerchant, type RiskLimits } from '../src/ledger/merchants.ts';
import { migrate } from '../src/scripts/migrate-lib.ts';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54329/ledgerline_test';

export async function setup() {
  const pool = createPool(TEST_DATABASE_URL, 40);
  await migrate(pool);
  const app = buildApp({ pool, adminToken: 'test-admin', logger: false });
  await app.ready();
  return { pool, app };
}

export type Ctx = Awaited<ReturnType<typeof setup>>;

/** Every test gets its own merchant, so tests never see each other's accounts. */
export async function newMerchant(pool: Pool, opts: { webhookUrl?: string; limits?: Partial<RiskLimits> } = {}) {
  const { merchant, apiKey, webhookSecret } = await createMerchant(pool, {
    name: `test-${randomUUID()}`,
    webhookUrl: opts.webhookUrl ?? null,
    limits: { maxTransferAmount: 1_000_000, dailyLimitAmount: 100_000_000, velocityMaxCount: 1000, ...opts.limits },
  });
  return { merchant, apiKey, webhookSecret, auth: { authorization: `Bearer ${apiKey}` } };
}

export async function newAccount(ctx: Ctx, apiKey: string, kind: 'wallet' | 'funding' = 'wallet', currency = 'USD') {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/accounts',
    headers: { authorization: `Bearer ${apiKey}` },
    payload: { name: `${kind}-${randomUUID()}`, currency, kind },
  });
  if (res.statusCode !== 201) throw new Error(`account create failed: ${res.body}`);
  return res.json().id as string;
}

export function transfer(
  ctx: Ctx,
  apiKey: string,
  body: { source_account_id: string; destination_account_id: string; amount: number; currency?: string; description?: string },
  key: string = randomUUID(),
) {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/transfers',
    headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': key },
    payload: { currency: 'USD', ...body },
  });
}

export async function balance(ctx: Ctx, apiKey: string, accountId: string): Promise<number> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/v1/accounts/${accountId}`,
    headers: { authorization: `Bearer ${apiKey}` },
  });
  return res.json().balance;
}

/** funding account + wallet holding `amount` */
export async function fundedWallet(ctx: Ctx, apiKey: string, amount: number) {
  const funding = await newAccount(ctx, apiKey, 'funding');
  const wallet = await newAccount(ctx, apiKey);
  const res = await transfer(ctx, apiKey, { source_account_id: funding, destination_account_id: wallet, amount });
  if (res.statusCode !== 201) throw new Error(`funding failed: ${res.body}`);
  return { funding, wallet };
}
