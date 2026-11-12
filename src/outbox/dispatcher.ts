import { config } from '../config.ts';
import type { Pool } from '../db.ts';
import { SIGNATURE_HEADER, signPayload } from './signature.ts';

/**
 * Exponential backoff with "equal jitter": the delay for attempt n is uniformly drawn from
 * [d/2, d] where d = min(maxDelay, baseDelay * 2^(n-1)). Jitter spreads retries from many
 * events that failed together (e.g. a merchant outage) so they do not stampede on recovery.
 */
export function backoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number, random = Math.random): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

export type DispatcherOptions = typeof config.outbox & { fetch?: typeof fetch };

type ClaimedEvent = {
  id: number;
  event_id: string;
  event_type: string;
  payload: unknown;
  attempts: number;
  webhook_url: string | null;
  webhook_secret: string;
};

type Outcome = { id: number; status: 'pending' | 'delivered' | 'dead'; code: number | null; error: string | null; delayMs: number | null };

/**
 * Delivers outbox events at-least-once. Events are claimed with a short lease (SKIP LOCKED, no transaction held
 * open across HTTP calls), so several dispatchers can run side by side and a crashed one's events are
 * picked up again once the lease expires. Receivers dedupe on the event id.
 */
export class OutboxDispatcher {
  readonly #pool: Pool;
  readonly #opts: DispatcherOptions;
  readonly #fetch: typeof fetch;
  #running = false;
  #timer: NodeJS.Timeout | undefined;
  #loop: Promise<void> | undefined;

  constructor(pool: Pool, opts: Partial<DispatcherOptions> = {}) {
    this.#pool = pool;
    this.#opts = { ...config.outbox, ...opts };
    this.#fetch = opts.fetch ?? fetch;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const tick = async () => {
      if (!this.#running) return;
      let claimed = 0;
      try {
        claimed = await this.runOnce();
      } catch (err) {
        console.error('outbox dispatcher error', err);
      }
      if (this.#running) this.#timer = setTimeout(() => (this.#loop = tick()), claimed >= this.#opts.batchSize ? 0 : this.#opts.pollIntervalMs);
    };
    this.#loop = tick();
  }

  async stop(): Promise<void> {
    this.#running = false;
    clearTimeout(this.#timer);
    await this.#loop;
  }

  /** Claims one batch of due events, delivers them concurrently and records the outcomes. Returns the batch size. */
  async runOnce(): Promise<number> {
    const { rows } = await this.#pool.query<ClaimedEvent>(
      `UPDATE outbox_events o
          SET attempts = o.attempts + 1,
              next_attempt_at = now() + $2 * interval '1 millisecond'
         FROM merchants m
        WHERE m.id = o.merchant_id
          AND o.id IN (SELECT id FROM outbox_events
                        WHERE status = 'pending' AND next_attempt_at <= now()
                        ORDER BY next_attempt_at, id
                        LIMIT $1
                        FOR UPDATE SKIP LOCKED)
      RETURNING o.id, o.event_id, o.event_type, o.payload, o.attempts, m.webhook_url, m.webhook_secret`,
      [this.#opts.batchSize, this.#opts.leaseMs],
    );
    if (rows.length === 0) return 0;

    const outcomes = await Promise.all(rows.map((e) => this.#deliver(e)));
    await this.#pool.query(
      `UPDATE outbox_events o
          SET status = u.status,
              delivered_at = CASE WHEN u.status = 'delivered' THEN now() END,
              next_attempt_at = CASE WHEN u.delay_ms IS NULL THEN o.next_attempt_at
                                     ELSE now() + u.delay_ms * interval '1 millisecond' END,
              last_response_status = u.code,
              last_error = u.error
         FROM unnest($1::bigint[], $2::text[], $3::int[], $4::text[], $5::float8[]) AS u(id, status, code, error, delay_ms)
        WHERE o.id = u.id`,
      [
        outcomes.map((o) => o.id),
        outcomes.map((o) => o.status),
        outcomes.map((o) => o.code),
        outcomes.map((o) => o.error),
        outcomes.map((o) => o.delayMs),
      ],
    );
    return rows.length;
  }

  async #deliver(e: ClaimedEvent): Promise<Outcome> {
    if (!e.webhook_url) return { id: e.id, status: 'dead', code: null, error: 'merchant has no webhook_url', delayMs: null };
    const body = JSON.stringify(e.payload);
    let code: number | null = null;
    let error: string | null = null;
    try {
      const res = await this.#fetch(e.webhook_url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Ledgerline-Webhooks/1.0',
          'ledgerline-event-id': e.event_id,
          'ledgerline-event-type': e.event_type,
          [SIGNATURE_HEADER]: signPayload(e.webhook_secret, body),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.#opts.requestTimeoutMs),
      });
      code = res.status;
      await res.body?.cancel();
      if (res.status >= 200 && res.status < 300) return { id: e.id, status: 'delivered', code, error: null, delayMs: null };
      error = `HTTP ${res.status}`;
    } catch (err) {
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
    if (e.attempts >= this.#opts.maxAttempts) return { id: e.id, status: 'dead', code, error, delayMs: null };
    return {
      id: e.id,
      status: 'pending',
      code,
      error,
      delayMs: backoffDelayMs(e.attempts, this.#opts.baseDelayMs, this.#opts.maxDelayMs),
    };
  }
}
