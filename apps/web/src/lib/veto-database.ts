import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Pool } from 'pg';

let pool: Pool | undefined;
let migration: Promise<void> | undefined;

export function databaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function database(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_UNCONFIGURED');
  pool ??= new Pool({ connectionString, max: 4 });
  return pool;
}

export async function ensureManagedRulesSchema(): Promise<void> {
  migration ??= (async () => {
    const migrationDirectory = path.resolve(process.cwd(), '../../db/migrations');
    const scripts = await Promise.all(
      [
        '0001_exit_intents.sql',
        '0002_proposal_decisions.sql',
        '0003_managed_rules.sql',
        '0004_keeperhub_conditional.sql',
        '0005_proposal_attempts.sql',
      ].map((name) => readFile(path.join(migrationDirectory, name), 'utf8')),
    );
    for (const sql of scripts) await database().query(sql);
    const verification = await database().query<{
      rules: string | null;
      checkpoints: string | null;
    }>(
      `SELECT
         to_regclass('public.managed_rules')::text AS rules,
         to_regclass('public.managed_rule_checkpoints')::text AS checkpoints`,
    );
    if (!verification.rows[0]?.rules || !verification.rows[0]?.checkpoints) {
      throw new Error('MANAGED_RULES_MIGRATION_MISSING');
    }
  })();
  return migration;
}
