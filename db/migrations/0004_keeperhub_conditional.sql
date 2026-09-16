ALTER TABLE exit_intents
  ADD COLUMN IF NOT EXISTS execution_mode text NOT NULL DEFAULT 'direct'
    CHECK (execution_mode IN ('direct', 'conditional')),
  ADD COLUMN IF NOT EXISTS conditional_request_json jsonb,
  ADD COLUMN IF NOT EXISTS serialized_conditional_request text;

ALTER TABLE exit_intents DROP CONSTRAINT IF EXISTS exit_intents_conditional_request_check;
ALTER TABLE exit_intents ADD CONSTRAINT exit_intents_conditional_request_check CHECK (
  execution_mode = 'direct'
  OR (conditional_request_json IS NOT NULL AND serialized_conditional_request IS NOT NULL)
);
