import pg from 'pg';
import { config } from './config.ts';

// bigint columns hold minor units; keep them as JS numbers but refuse silent precision loss.
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`int8 value ${value} exceeds Number.MAX_SAFE_INTEGER`);
  return n;
});

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

export function createPool(connectionString = config.databaseUrl, max = config.dbPoolSize): pg.Pool {
  const pool = new pg.Pool({ connectionString, max });
  pool.on('error', (err) => {
    console.error('idle postgres client error', err);
  });
  return pool;
}

export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
  begin = 'BEGIN',
): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query(begin);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      broken = rollbackErr as Error;
    }
    throw err;
  } finally {
    client.release(broken);
  }
}
