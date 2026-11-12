# Ledgerline

A payments service built around a double-entry ledger. It has idempotent transfer requests, merchant webhooks delivered through a transactional outbox, risk checks and a nightly reconciliation job.

Stack: Node.js 23.6+ (runs the TypeScript directly, with no build step), Fastify 5, PostgreSQL 18.

## Design

**Double-entry ledger.** Each posted transfer writes one `debit` entry on the source account and one `credit` entry on the destination, in the same transaction. Postgres enforces the invariants itself:

- A deferred constraint trigger rejects any transaction where a transfer's debits ≠ credits, or where it mixes currencies.
- `ledger_entries` is append-only. Triggers block `UPDATE`, `DELETE` and `TRUNCATE`.
- No table has a balance column. A balance is always `SUM(credits) − SUM(debits)` over the ledger, read through a covering index.

**Idempotency.** `POST /v1/transfers` requires an `Idempotency-Key` header. In one transaction the service:

1. claims the key with `INSERT … ON CONFLICT DO NOTHING` on the `(merchant_id, key)` primary key,
2. locks the source account (`FOR NO KEY UPDATE`, so it does not conflict with the FK locks taken when other transfers credit that account),
3. reads the balance and risk totals in a *new* statement, so the snapshot is taken after the lock is granted,
4. writes the transfer and its ledger legs, enqueues the webhook, and stores the HTTP response on the key.

A concurrent duplicate blocks on the unique index until the first request commits, then gets the stored response back with `Idempotent-Replayed: true`. If the same key comes back with a different body, the service returns `422`. A request that errors rolls back its key claim, so a retry runs cleanly. Declines (`402`) are stored too, so a retry never re-runs the risk decision. As a second guard, `transfers` has its own `UNIQUE (merchant_id, idempotency_key)`.

**Webhooks (transactional outbox).** The event row is inserted in the same transaction as the transfer, so a transfer is never committed without its event, and no event exists for a rolled-back transfer. The dispatcher works like this:

- It claims due events with a lease (`UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`), so no transaction stays open across HTTP calls and several dispatchers can run side by side.
- Each payload is signed with `Ledgerline-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`. The timestamp is part of the signed string, so receivers can reject replays. Several `v1` values are accepted, which allows secret rotation.
- Failed deliveries are retried with exponential backoff and equal jitter: `min(cap, base·2^(n−1))`, drawn from `[d/2, d]`. After `OUTBOX_MAX_ATTEMPTS` the event is marked `dead`. Delivery is at-least-once, and receivers dedupe on `Ledgerline-Event-Id`.

**Risk checks.** These run under the source-account lock, so concurrent requests cannot both slip under a limit:

- per-transfer amount limit
- trailing-24h amount limit
- velocity (posted transfers in the last N seconds)
- insufficient funds (`funding` accounts may go negative; they represent money entering the system)

Limits are set per merchant.

**Nightly reconciliation.** Every check reads one `REPEATABLE READ` snapshot, so live traffic can't produce false mismatches. An advisory lock means only one instance runs it. The checks:

- every posted transfer has exactly one debit on its source and one credit on its destination for its full amount, and declined transfers have no legs
- trial balance: debits = credits per currency
- per-account drift: the ledger-derived balance equals the balance implied by the transfers table
- no non-funding account has a negative balance
- no transfer is referenced by two idempotency keys

Each run is stored in `reconciliation_runs`, and the same job expires idempotency keys after `IDEMPOTENCY_TTL_HOURS`.

## Running it

```bash
npm install
npm run db:start          # embedded Postgres on :54329 (or: docker compose up -d)
npm run migrate
npm test                  # 36 tests against a real Postgres
ADMIN_TOKEN=change-me npm start
```

```bash
# create a merchant (returns api_key and webhook_secret once)
curl -X POST localhost:3000/v1/merchants -H 'authorization: Bearer change-me' \
  -H 'content-type: application/json' -d '{"name":"acme","webhook_url":"https://example.com/hooks"}'

curl -X POST localhost:3000/v1/accounts -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"name":"alice","currency":"USD"}'

curl -X POST localhost:3000/v1/transfers -H "authorization: Bearer $KEY" -H "idempotency-key: $(uuidgen)" \
  -H 'content-type: application/json' \
  -d '{"source_account_id":"…","destination_account_id":"…","amount":2500,"currency":"USD"}'
```

Endpoints:

- `POST /v1/merchants` (admin)
- `POST /v1/accounts`
- `GET /v1/accounts/:id` (includes the derived balance)
- `GET /v1/accounts/:id/entries`
- `POST /v1/transfers`
- `GET /v1/transfers/:id`
- `GET /healthz`

Run reconciliation on demand with `npm run reconcile`. It exits non-zero on any mismatch.

## Load test

```bash
npm run webhook-sink                                    # verifies every signature; fails 5% of deliveries on purpose
node src/scripts/seed.ts --wallets 2000 --webhook-url http://127.0.0.1:4000/webhooks
WEB_CONCURRENCY=4 DB_POOL_SIZE=16 LOG_LEVEL=warn npm start
k6 run -e RATE=2000 -e DURATION=120s loadtest/transfers.js
node loadtest/verify.ts loadtest/results/*.json         # k6 counts vs. DB, then full reconciliation
```

Traffic mix:

- random wallet-to-wallet transfers
- 1% above the per-transfer limit, which should be declined
- 4% sequential retries with the same key
- 1% concurrent same-key pairs

Each sequential retry and each concurrent pair must come back as a single transfer, and the run fails on any mismatch.

### Results

**Setup.** One laptop ran everything: k6, the API (4 processes), Postgres, the webhook sink and the outbox dispatcher. It has an Intel Core Ultra 9 285H (16 threads) and 31 GB RAM, running Windows 11. Postgres had durable commits (`fsync` and `synchronous_commit` on).

| Target rate, duration | Achieved HTTP req/s | p50 | p95 | p99 | Failed | Result |
|---|---|---|---|---|---|---|
| 1,000/s, 60s | 1,050 | 2.1 ms | 3.3 ms | 11.9 ms | 0% | pass |
| **2,000/s, 120s** | **2,098** | **3.7 ms** | **17.8 ms** | 178 ms | **0%** | **pass** |
| 2,500/s, 120s | 2,609 | 4.5 ms | 211 ms | 449 ms | 0.099% | fail: TCP accept queue overflow (`connection refused`) |
| 3,000/s, 120s | 3,076 | 19.8 ms | 780 ms | 1,368 ms | 0.065% | fail |
| 4,000/s, 60s | 3,399 | 559 ms | 1,751 ms | 2,482 ms | 0.077% | saturated |

Achieved req/s is higher than the target because idempotent retries are extra HTTP requests.

**Sustained: about 2,000 req/s with p95 ≈ 18 ms, 0 failed requests and 0 idempotency mismatches.**

Across all runs (1.46M transfers, 2.89M ledger entries):

- k6's count of `201` responses equals the posted transfers in the database, and its `402` count equals the declined transfers.
- There is exactly one transfer per idempotency key.
- Every account in the merchant's ledger sums to 0, and reconciliation reported **0 drift**. This held even in the overloaded runs.
- All 1.49M webhook deliveries had valid signatures. The 73,746 deliveries that failed on purpose were retried.
