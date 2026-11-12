// Starts a local PostgreSQL using the embedded-postgres binaries, so the project runs
// without Docker or a system install. Data lives in ./.pgdata. Ctrl+C to stop.
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dataDir = fileURLToPath(new URL('../../.pgdata', import.meta.url));
const port = Number(process.env.PGPORT ?? 54329);
const databases = (process.env.PG_DATABASES ?? 'ledgerline,ledgerline_test').split(',');

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: true,
  onLog: () => {},
  postgresFlags: ['-c', 'max_connections=300', '-c', 'shared_buffers=1GB', '-c', 'max_wal_size=4GB'],
});

if (!existsSync(dataDir)) await pg.initialise();
await pg.start();
for (const db of databases) {
  try {
    await pg.createDatabase(db);
  } catch {
    // already exists
  }
}
console.log(`postgres listening on localhost:${port} (databases: ${databases.join(', ')})`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
