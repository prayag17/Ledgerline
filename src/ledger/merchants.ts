import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from '../db.ts';

export type RiskLimits = {
  maxTransferAmount: number;
  dailyLimitAmount: number;
  velocityMaxCount: number;
  velocityWindowSeconds: number;
};

export type Merchant = {
  id: string;
  name: string;
  webhookUrl: string | null;
  limits: RiskLimits;
};

export function hashApiKey(apiKey: string): Buffer {
  return createHash('sha256').update(apiKey).digest();
}

type MerchantRow = {
  id: string;
  name: string;
  webhook_url: string | null;
  max_transfer_amount: number;
  daily_limit_amount: number;
  velocity_max_count: number;
  velocity_window_seconds: number;
};

function toMerchant(r: MerchantRow): Merchant {
  return {
    id: r.id,
    name: r.name,
    webhookUrl: r.webhook_url,
    limits: {
      maxTransferAmount: r.max_transfer_amount,
      dailyLimitAmount: r.daily_limit_amount,
      velocityMaxCount: r.velocity_max_count,
      velocityWindowSeconds: r.velocity_window_seconds,
    },
  };
}

export type CreateMerchantInput = {
  name: string;
  webhookUrl?: string | null;
  limits?: Partial<RiskLimits>;
};

export async function createMerchant(pool: Pool, input: CreateMerchantInput) {
  const apiKey = `sk_${randomBytes(24).toString('base64url')}`;
  const webhookSecret = `whsec_${randomBytes(24).toString('base64url')}`;
  const l = input.limits ?? {};
  const { rows } = await pool.query<MerchantRow>(
    `INSERT INTO merchants (name, api_key_hash, webhook_url, webhook_secret,
        max_transfer_amount, daily_limit_amount, velocity_max_count, velocity_window_seconds)
     VALUES ($1, $2, $3, $4,
        coalesce($5, 1000000), coalesce($6, 10000000), coalesce($7, 20), coalesce($8, 60))
     RETURNING *`,
    [
      input.name,
      hashApiKey(apiKey),
      input.webhookUrl ?? null,
      webhookSecret,
      l.maxTransferAmount ?? null,
      l.dailyLimitAmount ?? null,
      l.velocityMaxCount ?? null,
      l.velocityWindowSeconds ?? null,
    ],
  );
  return { merchant: toMerchant(rows[0]!), apiKey, webhookSecret };
}

/** Resolves API keys to merchants with a short in-process cache to keep auth off the hot path. */
export class MerchantAuthenticator {
  readonly #pool: Pool;
  readonly #ttlMs: number;
  readonly #cache = new Map<string, { merchant: Merchant | null; expires: number }>();

  constructor(pool: Pool, ttlMs = 30_000) {
    this.#pool = pool;
    this.#ttlMs = ttlMs;
  }

  async authenticate(apiKey: string): Promise<Merchant | null> {
    const hash = hashApiKey(apiKey);
    const cacheKey = hash.toString('hex');
    const hit = this.#cache.get(cacheKey);
    if (hit && hit.expires > Date.now()) return hit.merchant;
    const { rows } = await this.#pool.query<MerchantRow>('SELECT * FROM merchants WHERE api_key_hash = $1', [hash]);
    const merchant = rows[0] ? toMerchant(rows[0]) : null;
    if (this.#cache.size > 10_000) this.#cache.clear();
    this.#cache.set(cacheKey, { merchant, expires: Date.now() + this.#ttlMs });
    return merchant;
  }
}
