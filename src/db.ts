import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import type { Logger } from 'pino';

export const sql = postgres({
  max: 5,
  onnotice: () => {},
  // Optional fields from Baileys are often undefined; store them as NULL.
  transform: { undefined: null },
  // timestamptz and bigint come back as Date and string; ids are only passed back to SQL.
});

export type Sql = typeof sql;

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url).pathname;

/** Applies migrations/NNN_*.sql in order, each in its own transaction, under an advisory lock. */
export async function migrate(log: Logger): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('wa-ingest-migrate'))`;
    const done = new Set((await tx<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      log.info({ migration: file }, 'applying migration');
      await tx.unsafe(await readFile(join(MIGRATIONS_DIR, file), 'utf8'));
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
    }
  });
}
