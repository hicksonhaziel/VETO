DO $$ BEGIN
  CREATE TYPE veto_intent_state AS ENUM (
    'OBSERVED',
    'CHECKING',
    'NOT_APPLICABLE',
    'BLOCKED',
    'READY',
    'SIMULATED',
    'SUBMITTING',
    'PENDING',
    'CONFIRMING',
    'EXITED',
    'UNKNOWN',
    'RECONCILING',
    'CANCELLED',
    'EXPIRED',
    'DISPUTED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS exit_intents (
  operation_key text PRIMARY KEY,
  chain_id integer NOT NULL CHECK (chain_id > 0),
  guard_address text NOT NULL CHECK (guard_address ~ '^0x[0-9a-f]{40}$'),
  mandate_id numeric(78, 0) NOT NULL CHECK (mandate_id >= 0),
  proposal_identity text NOT NULL,
  proposal_data text NOT NULL CHECK (proposal_data ~ '^0x[0-9a-f]+$'),
  expected_executable_at numeric(78, 0) NOT NULL,
  state veto_intent_state NOT NULL DEFAULT 'READY',
  request_json jsonb NOT NULL,
  serialized_request text NOT NULL,
  idempotency_key text NOT NULL,
  execution_id text,
  transaction_hash text CHECK (
    transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-f]{64}$'
  ),
  last_error text,
  reconciliation_json jsonb,
  claimed_by text,
  claimed_at timestamptz,
  version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, guard_address, mandate_id),
  UNIQUE (idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS exit_intents_execution_id_unique
  ON exit_intents (execution_id)
  WHERE execution_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS exit_intent_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_key text NOT NULL REFERENCES exit_intents(operation_key),
  from_state veto_intent_state,
  to_state veto_intent_state NOT NULL,
  detail_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scanner_checkpoints (
  chain_id integer NOT NULL CHECK (chain_id > 0),
  vault_address text NOT NULL CHECK (vault_address ~ '^0x[0-9a-f]{40}$'),
  next_block numeric(78, 0) NOT NULL CHECK (next_block >= 0),
  last_block_hash text CHECK (
    last_block_hash IS NULL OR last_block_hash ~ '^0x[0-9a-f]{64}$'
  ),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, vault_address)
);
