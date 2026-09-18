ALTER TABLE managed_rules
  ADD COLUMN IF NOT EXISTS guard_version text NOT NULL DEFAULT 'v1',
  ADD COLUMN IF NOT EXISTS policy_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS policy_config_json jsonb;

CREATE INDEX IF NOT EXISTS managed_rules_guard_version
  ON managed_rules (guard_version);
