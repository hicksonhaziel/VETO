import { readFile } from 'node:fs/promises';

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
    const scripts = await Promise.all(
      ['0001_exit_intents.sql', '0002_proposal_decisions.sql', '0003_managed_rules.sql'].map(
        (name) => readFile(new URL(`../../../../db/migrations/${name}`, import.meta.url), 'utf8'),
      ),
    );
    for (const sql of scripts) await database().query(sql);
  })();
  return migration;
}
