// k6 load test for POST /v1/transfers.
//   k6 run -e RATE=1000 -e DURATION=60s loadtest/transfers.js
// Traffic mix per iteration:
//   ~1%  over the per-transfer limit (exercises risk declines, expect 402)
//   ~4%  sequential retry with the same idempotency key (expect identical response, Idempotent-Replayed)
//   ~1%  two concurrent requests with the same key (expect one transfer, both responses identical)
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const fixtures = JSON.parse(open('./fixtures.json'));
const RATE = Number(__ENV.RATE || 500);
const DURATION = __ENV.DURATION || '60s';
const OUT = __ENV.OUT || `loadtest/results/rate-${RATE}.json`;

export const options = {
  discardResponseBodies: false,
  scenarios: {
    transfers: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(50, Math.ceil(RATE / 4)),
      maxVUs: Math.max(200, RATE * 2),
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    replay_mismatch: ['count==0'],
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

http.setResponseCallback(http.expectedStatuses(201, 402));

const posted = new Counter('transfers_posted');
const declined = new Counter('transfers_declined');
const replays = new Counter('idempotent_replays');
const replayMismatch = new Counter('replay_mismatch');
const unexpected = new Counter('unexpected_responses');

const headers = (key) => ({
  'content-type': 'application/json',
  authorization: `Bearer ${fixtures.apiKey}`,
  'idempotency-key': key,
});

function pickPair() {
  const n = fixtures.wallets.length;
  const a = Math.floor(Math.random() * n);
  let b = Math.floor(Math.random() * (n - 1));
  if (b >= a) b++;
  return [fixtures.wallets[a], fixtures.wallets[b]];
}

function record(res) {
  if (res.status !== 201 && res.status !== 402) {
    unexpected.add(1, { status: String(res.status), error_code: String(res.error_code || 0) });
    console.warn(`unexpected response status=${res.status} error_code=${res.error_code} error=${res.error}`);
  }
  if (res.headers['Idempotent-Replayed'] === 'true') return;
  if (res.status === 201) posted.add(1);
  else if (res.status === 402) declined.add(1);
}

export default function () {
  const [src, dst] = pickPair();
  const roll = Math.random();
  const amount = roll < 0.01 ? 150000 : 1 + Math.floor(Math.random() * 10000);
  const key = `k6-${__VU}-${__ITER}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const body = JSON.stringify({ source_account_id: src, destination_account_id: dst, amount, currency: fixtures.currency });
  const url = `${fixtures.baseUrl}/v1/transfers`;

  if (roll >= 0.99) {
    // concurrent duplicate
    const [r1, r2] = http.batch([
      ['POST', url, body, { headers: headers(key), tags: { name: 'create_transfer' } }],
      ['POST', url, body, { headers: headers(key), tags: { name: 'create_transfer' } }],
    ]);
    record(r1);
    record(r2);
    const same = r1.status === r2.status && r1.json('id') === r2.json('id');
    const oneReplayed = [r1, r2].filter((r) => r.headers['Idempotent-Replayed'] === 'true').length === 1;
    replays.add(1);
    if (!same || !oneReplayed) replayMismatch.add(1);
    check(null, { 'concurrent duplicate collapsed to one transfer': () => same && oneReplayed });
    return;
  }

  const res = http.post(url, body, { headers: headers(key), tags: { name: 'create_transfer' } });
  record(res);
  check(res, {
    'status is 201 or 402': (r) => r.status === 201 || r.status === 402,
    'over-limit amounts are declined': (r) => amount <= 100000 || r.json('decline_reason') === 'amount_limit_exceeded',
  });

  if (roll >= 0.95 && (res.status === 201 || res.status === 402)) {
    const retry = http.post(url, body, { headers: headers(key), tags: { name: 'create_transfer' } });
    replays.add(1);
    const ok =
      retry.status === res.status &&
      retry.json('id') === res.json('id') &&
      retry.headers['Idempotent-Replayed'] === 'true';
    if (!ok) replayMismatch.add(1);
    check(retry, { 'retry returns the stored response': () => ok });
  }
}

export function handleSummary(data) {
  const m = data.metrics;
  const d = m.http_req_duration.values;
  const iterations = m.iterations ? m.iterations.values : { count: 0, rate: 0 };
  const result = {
    target_rate: RATE,
    duration: DURATION,
    http_reqs: m.http_reqs.values.count,
    http_req_rate: m.http_reqs.values.rate,
    iterations: iterations.count,
    iteration_rate: iterations.rate,
    dropped_iterations: m.dropped_iterations ? m.dropped_iterations.values.count : 0,
    failed_rate: m.http_req_failed.values.rate,
    latency_ms: { avg: d.avg, med: d.med, p90: d['p(90)'], p95: d['p(95)'], p99: d['p(99)'], max: d.max },
    transfers_posted: m.transfers_posted ? m.transfers_posted.values.count : 0,
    transfers_declined: m.transfers_declined ? m.transfers_declined.values.count : 0,
    idempotent_replays: m.idempotent_replays ? m.idempotent_replays.values.count : 0,
    replay_mismatch: m.replay_mismatch ? m.replay_mismatch.values.count : 0,
    unexpected_responses: m.unexpected_responses ? m.unexpected_responses.values.count : 0,
    thresholds_passed: Object.values(m).every((x) => !x.thresholds || Object.values(x.thresholds).every((t) => t.ok)),
  };
  const line =
    `rate=${RATE}/s  reqs=${result.http_reqs} (${result.http_req_rate.toFixed(0)}/s)  ` +
    `p50=${d.med.toFixed(1)}ms p95=${d['p(95)'].toFixed(1)}ms p99=${d['p(99)'].toFixed(1)}ms  ` +
    `failed=${(result.failed_rate * 100).toFixed(3)}%  dropped=${result.dropped_iterations}  ` +
    `posted=${result.transfers_posted} declined=${result.transfers_declined} replays=${result.idempotent_replays} ` +
    `replay_mismatch=${result.replay_mismatch} unexpected=${result.unexpected_responses}  thresholds=${result.thresholds_passed ? 'PASS' : 'FAIL'}\n`;
  return { stdout: line, [OUT]: JSON.stringify(result, null, 2) };
}
