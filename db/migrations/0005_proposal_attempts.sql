-- Preserve historical requests and keys. New attempts identify a proposal occurrence.
ALTER TABLE exit_intents DROP CONSTRAINT IF EXISTS exit_intents_chain_id_guard_address_mandate_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS exit_intents_mandate_proposal_unique
  ON exit_intents (chain_id, guard_address, mandate_id, proposal_identity);
CREATE INDEX IF NOT EXISTS exit_intents_mandate_attempts
  ON exit_intents (chain_id, guard_address, mandate_id, created_at, operation_key);
