CREATE TABLE IF NOT EXISTS proposal_decisions (
  proposal_identity text NOT NULL,
  operation_key text NOT NULL,
  chain_id integer NOT NULL CHECK (chain_id > 0),
  vault_address text NOT NULL CHECK (vault_address ~ '^0x[0-9a-f]{40}$'),
  mandate_id numeric(78, 0) NOT NULL CHECK (mandate_id >= 0),
  decision text NOT NULL,
  assessment_json jsonb NOT NULL,
  source_block numeric(78, 0) NOT NULL CHECK (source_block >= 0),
  source_transaction_hash text NOT NULL CHECK (
    source_transaction_hash ~ '^0x[0-9a-f]{64}$'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_identity, operation_key)
);
