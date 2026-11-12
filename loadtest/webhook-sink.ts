// Merchant-side webhook receiver used during load tests. Verifies every signature, dedupes on event id,
// and can fail a fraction of deliveries (FAIL_RATE) to exercise the dispatcher's retries.
//   node loadtest/webhook-sink.ts            -> listens on :4000, stats at GET /stats
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { SIGNATURE_HEADER, verifySignature } from '../src/outbox/signature.ts';

const port = Number(process.env.SINK_PORT ?? 4000);
const failRate = Number(process.env.FAIL_RATE ?? 0.05);
const fixturesPath = process.env.FIXTURES ?? 'loadtest/fixtures.json';

let secret = '';
const loadSecret = () => {
  try {
    secret = JSON.parse(readFileSync(fixturesPath, 'utf8')).webhookSecret;
  } catch {
    secret = '';
  }
};
loadSecret();

const seen = new Set<string>();
const stats = { deliveries: 0, valid: 0, invalid: 0, injectedFailures: 0, duplicates: 0, unique: 0 };

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/stats') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(stats));
    return;
  }
  if (req.method === 'POST' && req.url === '/reload') {
    loadSecret();
    Object.assign(stats, { deliveries: 0, valid: 0, invalid: 0, injectedFailures: 0, duplicates: 0, unique: 0 });
    seen.clear();
    res.writeHead(204).end();
    return;
  }
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    stats.deliveries++;
    const body = Buffer.concat(chunks).toString('utf8');
    if (!verifySignature(secret, body, req.headers[SIGNATURE_HEADER] as string | undefined)) {
      stats.invalid++;
      res.writeHead(401).end();
      return;
    }
    stats.valid++;
    if (Math.random() < failRate) {
      stats.injectedFailures++;
      res.writeHead(503).end();
      return;
    }
    const id = String(req.headers['ledgerline-event-id']);
    if (seen.has(id)) stats.duplicates++;
    else {
      seen.add(id);
      stats.unique++;
    }
    res.writeHead(200).end();
  });
}).listen(port, () => console.log(`webhook sink on :${port} (fail rate ${failRate})`));
