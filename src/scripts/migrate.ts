import { createPool } from '../db.ts';
import { migrate } from './migrate-lib.ts';

const pool = createPool();
try {
  const applied = await migrate(pool);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'schema up to date');
} finally {
  await pool.end();
}
