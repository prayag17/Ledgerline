import { createHash, randomUUID } from 'node:crypto';
import type { Client, Pool } from '../db.ts';
import { withTransaction } from '../db.ts';
import { ApiError } from '../errors.ts';
import type { Merchant } from './merchants.ts';
import { evaluateRisk } from './risk.ts';
import { serializeTransfer, type TransferRow } from './serialize.ts';

export type TransferInput = {
  sourceAccountId: string;
  destinationAccountId: string;
  amount: number;
  currency: string;
  description: string | null;
};

export type TransferResult = {
  status: number;
  body: unknown;
  /** true when the response was served from a previously stored idempotent result */
  replayed: boolean;
};

/** Hash of the semantically relevant request fields; a key reused with a different request is rejected. */
export function hashTransferRequest(input: TransferInput): string {
  const canonical = JSON.stringify([
    input.sourceAccountId,
    input.destinationAccountId,
    input.amount,
    input.currency,
    input.description,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Creates a transfer exactly once per (merchant, idempotency key).
 *
 * Everything happens in one database transaction:
 *   1. claim the idempotency key (INSERT ... ON CONFLICT DO NOTHING). A concurrent duplicate blocks on the
 *      unique index until the first transaction commits, then falls through to the stored-response path.
 *   2. lock the source account row, so balance and risk reads for that account are serialised.
 *   3. read balance (SUM over the ledger) and velocity/daily totals in a fresh statement after the lock.
 *   4. insert the transfer and, if posted, its debit and credit legs (a deferred trigger asserts balance).
 *   5. enqueue the webhook in the outbox and store the response on the idempotency key.
 * If anything fails, all of it rolls back, including the key claim, so a retry re-executes safely.
 */
export async function createTransfer(
  pool: Pool,
  merchant: Merchant,
  idempotencyKey: string,
  input: TransferInput,
): Promise<TransferResult> {
  if (input.sourceAccountId === input.destinationAccountId) {
    throw new ApiError(400, 'invalid_request', 'source and destination accounts must differ');
  }
  const requestHash = hashTransferRequest(input);

  return withTransaction(pool, async (c) => {
    const claim = await c.query(
      `INSERT INTO idempotency_keys (merchant_id, key, request_hash) VALUES ($1, $2, $3)
       ON CONFLICT (merchant_id, key) DO NOTHING`,
      [merchant.id, idempotencyKey, requestHash],
    );
    if (claim.rowCount === 0) return replay(c, merchant.id, idempotencyKey, requestHash);

    // FOR NO KEY UPDATE (not FOR UPDATE) so it does not conflict with the KEY SHARE locks that foreign keys
    // take when other transfers credit this account; only concurrent debits of the same account serialise.
    const { rows: [source] } = await c.query<{ currency: string; allow_negative: boolean }>(
      `SELECT currency, allow_negative FROM accounts WHERE id = $1 AND merchant_id = $2 FOR NO KEY UPDATE`,
      [input.sourceAccountId, merchant.id],
    );
    if (!source) throw new ApiError(404, 'account_not_found', 'source account not found');

    // New statement => new snapshot taken after the lock was granted, so prior debits are visible.
    const { rows: [ctx] } = await c.query<{
      destination_currency: string | null;
      balance: number;
      recent_count: number;
      day_amount: number;
    }>(
      `SELECT
         (SELECT currency FROM accounts WHERE id = $2 AND merchant_id = $3) AS destination_currency,
         (SELECT coalesce(sum(CASE WHEN direction = 'credit' THEN amount ELSE -amount END), 0)::bigint
            FROM ledger_entries WHERE account_id = $1) AS balance,
         (SELECT count(*) FROM transfers
           WHERE source_account_id = $1 AND status = 'posted'
             AND created_at > now() - make_interval(secs => $4)) AS recent_count,
         (SELECT coalesce(sum(amount), 0)::bigint FROM transfers
           WHERE source_account_id = $1 AND status = 'posted'
             AND created_at > now() - interval '24 hours') AS day_amount`,
      [input.sourceAccountId, input.destinationAccountId, merchant.id, merchant.limits.velocityWindowSeconds],
    );
    if (!ctx || ctx.destination_currency === null) {
      throw new ApiError(404, 'account_not_found', 'destination account not found');
    }
    if (source.currency !== input.currency || ctx.destination_currency !== input.currency) {
      throw new ApiError(422, 'currency_mismatch', 'both accounts must be denominated in the transfer currency');
    }

    const declineReason = evaluateRisk(
      {
        amount: input.amount,
        recentCount: ctx.recent_count,
        trailingDayAmount: ctx.day_amount,
        balance: ctx.balance,
        allowNegative: source.allow_negative,
      },
      merchant.limits,
    );
    const status = declineReason ? 'declined' : 'posted';

    const { rows: [row] } = await c.query<TransferRow>(
      `WITH t AS (
         INSERT INTO transfers (id, merchant_id, idempotency_key, source_account_id, destination_account_id,
                                amount, currency, status, decline_reason, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *
       ), legs AS (
         INSERT INTO ledger_entries (transfer_id, account_id, direction, amount, currency)
         SELECT id, source_account_id, 'debit', amount, currency FROM t WHERE status = 'posted'
         UNION ALL
         SELECT id, destination_account_id, 'credit', amount, currency FROM t WHERE status = 'posted'
       )
       SELECT * FROM t`,
      [
        randomUUID(),
        merchant.id,
        idempotencyKey,
        input.sourceAccountId,
        input.destinationAccountId,
        input.amount,
        input.currency,
        status,
        declineReason,
        input.description,
      ],
    );
    const transfer = serializeTransfer(row!);
    const httpStatus = status === 'posted' ? 201 : 402;
    const eventId = randomUUID();
    const eventType = `transfer.${status}`;

    await c.query(
      `WITH outbox AS (
         INSERT INTO outbox_events (event_id, merchant_id, event_type, transfer_id, payload)
         SELECT $1, $2, $3, $4, $5 WHERE $6::boolean
       )
       UPDATE idempotency_keys SET response_status = $7, response_body = $8, transfer_id = $4
        WHERE merchant_id = $2 AND key = $9`,
      [
        eventId,
        merchant.id,
        eventType,
        transfer.id,
        { id: eventId, type: eventType, created_at: transfer.created_at, data: { object: transfer } },
        merchant.webhookUrl !== null,
        httpStatus,
        transfer,
        idempotencyKey,
      ],
    );

    return { status: httpStatus, body: transfer, replayed: false };
  });
}

async function replay(c: Client, merchantId: string, key: string, requestHash: string): Promise<TransferResult> {
  const { rows: [prev] } = await c.query<{ request_hash: string; response_status: number; response_body: unknown }>(
    `SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE merchant_id = $1 AND key = $2`,
    [merchantId, key],
  );
  if (!prev) {
    // the conflicting row disappeared (expired between statements); ask the client to retry
    throw new ApiError(409, 'idempotency_conflict', 'request with this idempotency key is in an unknown state; retry');
  }
  if (prev.request_hash !== requestHash) {
    throw new ApiError(422, 'idempotency_key_reused', 'idempotency key was already used with a different request');
  }
  return { status: prev.response_status, body: prev.response_body, replayed: true };
}

export async function getTransfer(pool: Pool, merchantId: string, id: string) {
  const { rows } = await pool.query<TransferRow>('SELECT * FROM transfers WHERE id = $1 AND merchant_id = $2', [
    id,
    merchantId,
  ]);
  return rows[0] ? serializeTransfer(rows[0]) : null;
}
