-- Ledgerline schema.
-- Money is always an integer number of minor units (cents). Balances are never stored:
-- they are derived from the append-only ledger_entries table.

CREATE TABLE merchants (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    text NOT NULL,
  api_key_hash            bytea NOT NULL UNIQUE,          -- sha256(api key); the key itself is never stored
  webhook_url             text,
  webhook_secret          text NOT NULL,
  -- risk limits
  max_transfer_amount     bigint NOT NULL DEFAULT 1000000   CHECK (max_transfer_amount > 0),
  daily_limit_amount      bigint NOT NULL DEFAULT 10000000  CHECK (daily_limit_amount > 0),
  velocity_max_count      integer NOT NULL DEFAULT 20       CHECK (velocity_max_count > 0),
  velocity_window_seconds integer NOT NULL DEFAULT 60       CHECK (velocity_window_seconds > 0),
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id    uuid NOT NULL REFERENCES merchants(id),
  name           text NOT NULL,
  currency       char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  kind           text NOT NULL CHECK (kind IN ('wallet', 'funding')),
  -- funding accounts represent money entering from outside the system and may go negative
  allow_negative boolean NOT NULL GENERATED ALWAYS AS (kind = 'funding') STORED,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX accounts_merchant_idx ON accounts (merchant_id);

CREATE TABLE transfers (
  id                     uuid PRIMARY KEY,
  merchant_id            uuid NOT NULL REFERENCES merchants(id),
  idempotency_key        text NOT NULL,
  source_account_id      uuid NOT NULL REFERENCES accounts(id),
  destination_account_id uuid NOT NULL REFERENCES accounts(id),
  amount                 bigint NOT NULL CHECK (amount > 0),
  currency               char(3) NOT NULL,
  status                 text NOT NULL CHECK (status IN ('posted', 'declined')),
  decline_reason         text,
  description            text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (source_account_id <> destination_account_id),
  CHECK ((status = 'declined') = (decline_reason IS NOT NULL)),
  -- second line of defence against double charges: one transfer per key, ever
  UNIQUE (merchant_id, idempotency_key)
);
-- velocity and daily-limit lookups
CREATE INDEX transfers_source_posted_idx ON transfers (source_account_id, created_at) WHERE status = 'posted';

CREATE TABLE ledger_entries (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id uuid NOT NULL REFERENCES transfers(id),
  account_id  uuid NOT NULL REFERENCES accounts(id),
  direction   text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount      bigint NOT NULL CHECK (amount > 0),
  currency    char(3) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, id) INCLUDE (direction, amount);
CREATE INDEX ledger_entries_transfer_idx ON ledger_entries (transfer_id);

-- Every transfer must balance (sum of debits = sum of credits, single currency).
-- Deferred to COMMIT so both legs can be inserted first.
CREATE FUNCTION assert_transfer_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  debits bigint;
  credits bigint;
  currencies integer;
BEGIN
  SELECT coalesce(sum(amount) FILTER (WHERE direction = 'debit'), 0),
         coalesce(sum(amount) FILTER (WHERE direction = 'credit'), 0),
         count(DISTINCT currency)
    INTO debits, credits, currencies
    FROM ledger_entries
   WHERE transfer_id = NEW.transfer_id;
  IF debits <> credits THEN
    RAISE EXCEPTION 'unbalanced transfer %: debits % <> credits %', NEW.transfer_id, debits, credits
      USING ERRCODE = 'check_violation';
  END IF;
  IF currencies > 1 THEN
    RAISE EXCEPTION 'transfer % mixes currencies', NEW.transfer_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_transfer_balanced();

-- The ledger is append-only. Corrections are new, reversing transfers.
CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_ledger_mutation();

-- Idempotency: the key row is claimed and the response stored in the same transaction
-- as the transfer itself, so a key is either absent or carries a complete response.
CREATE TABLE idempotency_keys (
  merchant_id     uuid NOT NULL REFERENCES merchants(id),
  key             text NOT NULL,
  request_hash    text NOT NULL,
  response_status integer,
  response_body   jsonb,
  transfer_id     uuid UNIQUE REFERENCES transfers(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, key)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

-- Transactional outbox for merchant webhooks.
CREATE TABLE outbox_events (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id             uuid NOT NULL UNIQUE,
  merchant_id          uuid NOT NULL REFERENCES merchants(id),
  event_type           text NOT NULL,
  transfer_id          uuid REFERENCES transfers(id),
  payload              jsonb NOT NULL,
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
  attempts             integer NOT NULL DEFAULT 0,
  next_attempt_at      timestamptz NOT NULL DEFAULT now(),
  last_error           text,
  last_response_status integer,
  created_at           timestamptz NOT NULL DEFAULT now(),
  delivered_at         timestamptz
);
CREATE INDEX outbox_events_due_idx ON outbox_events (next_attempt_at, id) WHERE status = 'pending';

CREATE TABLE reconciliation_runs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      text NOT NULL CHECK (status IN ('running', 'ok', 'mismatch', 'error')),
  summary     jsonb
);
