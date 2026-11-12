try {
  process.loadEnvFile();
} catch {
  // no .env file; rely on the real environment
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54329/ledgerline',
  host: process.env.HOST ?? '0.0.0.0',
  port: int('PORT', 3000),
  adminToken: process.env.ADMIN_TOKEN ?? '',
  dbPoolSize: int('DB_POOL_SIZE', 20),
  /** number of API processes (node:cluster); 1 = single process */
  webConcurrency: int('WEB_CONCURRENCY', 1),
  /** run the outbox dispatcher and reconciliation scheduler in this deployment */
  runWorkers: bool('RUN_WORKERS', true),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  idempotencyTtlHours: int('IDEMPOTENCY_TTL_HOURS', 24),
  outbox: {
    pollIntervalMs: int('OUTBOX_POLL_MS', 200),
    batchSize: int('OUTBOX_BATCH_SIZE', 100),
    maxAttempts: int('OUTBOX_MAX_ATTEMPTS', 15),
    baseDelayMs: int('OUTBOX_BASE_DELAY_MS', 1000),
    maxDelayMs: int('OUTBOX_MAX_DELAY_MS', 3_600_000),
    requestTimeoutMs: int('OUTBOX_TIMEOUT_MS', 10_000),
    leaseMs: int('OUTBOX_LEASE_MS', 30_000),
  },
  recon: {
    hourUtc: int('RECON_HOUR_UTC', 2),
  },
};

export type Config = typeof config;
