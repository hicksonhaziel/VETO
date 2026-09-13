CREATE TABLE IF NOT EXISTS managed_rules (
  chain_id integer NOT NULL CHECK (chain_id > 0),
  factory_address text NOT NULL CHECK (factory_address ~ '^0x[0-9a-f]{40}$'),
  guard_address text NOT NULL CHECK (guard_address ~ '^0x[0-9a-f]{40}$'),
  mandate_id numeric(78, 0) NOT NULL CHECK (mandate_id >= 0),
  owner_address text NOT NULL CHECK (owner_address ~ '^0x[0-9a-f]{40}$'),
  vault_address text NOT NULL CHECK (vault_address ~ '^0x[0-9a-f]{40}$'),
  shares numeric(78, 0) NOT NULL CHECK (shares > 0),
  max_fee_per_second numeric(78, 0) NOT NULL,
  min_assets numeric(78, 0) NOT NULL CHECK (min_assets > 0),
  expires_at numeric(78, 0) NOT NULL,
  safety_seconds numeric(78, 0) NOT NULL CHECK (safety_seconds > 0),
  arm_transaction_hash text NOT NULL CHECK (arm_transaction_hash ~ '^0x[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'CANCELLED', 'EXITED')),
  cancel_transaction_hash text CHECK (
    cancel_transaction_hash IS NULL OR cancel_transaction_hash ~ '^0x[0-9a-f]{64}$'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, guard_address, mandate_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS managed_rules_active_owner_vault
  ON managed_rules (chain_id, owner_address, vault_address)
  WHERE state = 'ACTIVE';

CREATE INDEX IF NOT EXISTS managed_rules_owner_created
  ON managed_rules (owner_address, created_at DESC);
