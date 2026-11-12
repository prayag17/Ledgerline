import cluster from 'node:cluster';
import { config } from './config.ts';
import { createPool } from './db.ts';
import { buildApp } from './http/app.ts';
import { OutboxDispatcher } from './outbox/dispatcher.ts';
import { scheduleNightlyReconciliation } from './recon/reconcile.ts';

function startWorkers() {
  const pool = createPool(config.databaseUrl, 10);
  const dispatcher = new OutboxDispatcher(pool);
  dispatcher.start();
  const stopRecon = scheduleNightlyReconciliation(pool);
  console.log(`outbox dispatcher started; reconciliation scheduled daily at ${config.recon.hourUtc}:00 UTC`);
  return async () => {
    stopRecon();
    await dispatcher.stop();
    await pool.end();
  };
}

async function startApi() {
  const pool = createPool();
  const app = buildApp({ pool });
  await app.listen({ host: config.host, port: config.port });
  return async () => {
    await app.close();
    await pool.end();
  };
}

const stoppers: (() => Promise<void>)[] = [];
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const stop of stoppers) await stop().catch((err) => console.error(err));
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (config.webConcurrency > 1 && cluster.isPrimary) {
  // primary forks API processes and runs the background workers itself
  for (let i = 0; i < config.webConcurrency; i++) cluster.fork();
  cluster.on('exit', (worker, code) => {
    if (shuttingDown) return;
    console.error(`api worker ${worker.process.pid} exited (${code}); restarting`);
    cluster.fork();
  });
  if (config.runWorkers) stoppers.push(startWorkers());
} else {
  stoppers.push(await startApi());
  if (config.webConcurrency <= 1 && config.runWorkers) stoppers.push(startWorkers());
}
