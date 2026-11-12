import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.ts';
import type { Pool } from '../db.ts';
import { ApiError, pgErrorCode } from '../errors.ts';
import { createAccount, getAccount, listEntries } from '../ledger/accounts.ts';
import { createMerchant, MerchantAuthenticator, type Merchant } from '../ledger/merchants.ts';
import { createTransfer, getTransfer } from '../ledger/transfers.ts';

declare module 'fastify' {
  interface FastifyRequest {
    merchant: Merchant | null;
  }
}

const uuid = { type: 'string', format: 'uuid' } as const;
const currency = { type: 'string', pattern: '^[A-Z]{3}$' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const digits = { type: 'string', pattern: '^[0-9]{1,15}$' } as const;

export type AppOptions = { pool: Pool; adminToken?: string; logger?: boolean };

export function buildApp({ pool, adminToken = config.adminToken, logger = true }: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: logger ? { level: config.logLevel } : false,
    // payments API: no silent type coercion ("100" is not 100) and no silently dropped fields
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  const auth = new MerchantAuthenticator(pool);

  app.decorateRequest('merchant', null);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    }
    const e = err as { validation?: unknown; statusCode?: number; message: string };
    if (e.validation) {
      return reply.status(400).send({ error: { code: 'invalid_request', message: e.message } });
    }
    const code = pgErrorCode(err);
    if (code === '40P01' || code === '40001') {
      return reply.status(409).send({ error: { code: 'conflict', message: 'concurrent update, retry the request' } });
    }
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: 'invalid_request', message: e.message } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'internal_error', message: 'internal error' } });
  });

  const requireMerchant = async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    const key = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const merchant = key ? await auth.authenticate(key) : null;
    if (!merchant) throw new ApiError(401, 'unauthorized', 'missing or invalid API key');
    req.merchant = merchant;
  };

  const requireAdmin = async (req: FastifyRequest) => {
    const given = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${adminToken}`);
    if (!adminToken || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new ApiError(401, 'unauthorized', 'admin token required');
    }
  };

  app.get('/healthz', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  app.post<{
    Body: {
      name: string;
      webhook_url?: string | null;
      max_transfer_amount?: number;
      daily_limit_amount?: number;
      velocity_max_count?: number;
      velocity_window_seconds?: number;
    };
  }>(
    '/v1/merchants',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            webhook_url: { type: ['string', 'null'], format: 'uri' },
            max_transfer_amount: { type: 'integer', minimum: 1 },
            daily_limit_amount: { type: 'integer', minimum: 1 },
            velocity_max_count: { type: 'integer', minimum: 1 },
            velocity_window_seconds: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const { merchant, apiKey, webhookSecret } = await createMerchant(pool, {
        name: b.name,
        webhookUrl: b.webhook_url ?? null,
        limits: {
          maxTransferAmount: b.max_transfer_amount,
          dailyLimitAmount: b.daily_limit_amount,
          velocityMaxCount: b.velocity_max_count,
          velocityWindowSeconds: b.velocity_window_seconds,
        },
      });
      return reply.status(201).send({
        id: merchant.id,
        object: 'merchant',
        name: merchant.name,
        webhook_url: merchant.webhookUrl,
        limits: merchant.limits,
        api_key: apiKey,
        webhook_secret: webhookSecret,
      });
    },
  );

  app.post<{ Body: { name: string; currency: string; kind?: 'wallet' | 'funding' } }>(
    '/v1/accounts',
    {
      preHandler: requireMerchant,
      schema: {
        body: {
          type: 'object',
          required: ['name', 'currency'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            currency,
            kind: { type: 'string', enum: ['wallet', 'funding'] },
          },
        },
      },
    },
    async (req, reply) => {
      const account = await createAccount(pool, req.merchant!.id, {
        name: req.body.name,
        currency: req.body.currency,
        kind: req.body.kind ?? 'wallet',
      });
      return reply.status(201).send(account);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/accounts/:id',
    { preHandler: requireMerchant, schema: { params: idParams } },
    async (req) => {
      const account = await getAccount(pool, req.merchant!.id, req.params.id);
      if (!account) throw new ApiError(404, 'account_not_found', 'account not found');
      return account;
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string; before?: string } }>(
    '/v1/accounts/:id/entries',
    {
      preHandler: requireMerchant,
      schema: { params: idParams, querystring: { type: 'object', properties: { limit: digits, before: digits } } },
    },
    async (req) => {
      const account = await getAccount(pool, req.merchant!.id, req.params.id);
      if (!account) throw new ApiError(404, 'account_not_found', 'account not found');
      const limit = Math.max(1, Math.min(Number(req.query.limit ?? 50), 200));
      const before = req.query.before ? Number(req.query.before) : undefined;
      const data = await listEntries(pool, req.merchant!.id, req.params.id, limit, before);
      return { object: 'list', data, has_more: data.length === limit };
    },
  );

  app.post<{
    Body: {
      source_account_id: string;
      destination_account_id: string;
      amount: number;
      currency: string;
      description?: string;
    };
  }>(
    '/v1/transfers',
    {
      preHandler: requireMerchant,
      schema: {
        headers: {
          type: 'object',
          required: ['idempotency-key'],
          properties: { 'idempotency-key': { type: 'string', minLength: 1, maxLength: 255 } },
        },
        body: {
          type: 'object',
          required: ['source_account_id', 'destination_account_id', 'amount', 'currency'],
          additionalProperties: false,
          properties: {
            source_account_id: uuid,
            destination_account_id: uuid,
            amount: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
            currency,
            description: { type: 'string', maxLength: 500 },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const result = await createTransfer(pool, req.merchant!, String(req.headers['idempotency-key']), {
        sourceAccountId: b.source_account_id,
        destinationAccountId: b.destination_account_id,
        amount: b.amount,
        currency: b.currency,
        description: b.description ?? null,
      });
      if (result.replayed) reply.header('idempotent-replayed', 'true');
      return reply.status(result.status).send(result.body);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/transfers/:id',
    { preHandler: requireMerchant, schema: { params: idParams } },
    async (req) => {
      const transfer = await getTransfer(pool, req.merchant!.id, req.params.id);
      if (!transfer) throw new ApiError(404, 'transfer_not_found', 'transfer not found');
      return transfer;
    },
  );

  return app;
}
