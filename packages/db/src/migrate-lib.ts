import postgres from "postgres";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { drizzleDirectory, listMigrationFiles } from "./migrations.js";
import { migrateOnConnection, migrationChecksum, type MigrationFile, type MigrationOptions } from "./migration-engine.js";
import { detectLegacyBaseline, verifyLegacyBaseline } from "./migration-baseline.js";

export async function readMigrationFiles(): Promise<MigrationFile[]> {
  return Promise.all((await listMigrationFiles()).map(async (name) => {
    const sql = await readFile(path.join(drizzleDirectory(), name), "utf8");
    return { name, sql, checksum: migrationChecksum(sql) };
  }));
}
export async function applyMigrations(url: string, options: MigrationOptions = {}) {
  const files = await readMigrationFiles();
  const client = postgres(url, { max: 1, prepare: false, connect_timeout: 10, onnotice: () => undefined });
  try {
    // The transaction owns both the advisory lock and every ledger/schema write.
    // A failed migration rolls back this run, including its history rows.
    return await client.begin(async (tx) => {
      // PostgreSQL itself enforces that plans cannot modify persistent state.
      // Set this before any catalog read; it is restored at transaction end.
      if (options.plan) await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
      await tx`SET LOCAL lock_timeout = '10s'`;
      await tx`SET LOCAL statement_timeout = '120s'`;
      return migrateOnConnection({
        query: async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
          [...await tx.unsafe<T[]>(text, params as postgres.ParameterOrJSON<never>[])],
        exec: async (text) => { await tx.unsafe(text).simple(); },
      }, files, {
        ...options,
        verifyBaseline: options.verifyBaseline ?? ((db, migrations) => verifyLegacyBaseline(db, migrations, options)),
        inspectBaseline: options.inspectBaseline ?? (options.verifyBaseline ? undefined : (db, migrations) => detectLegacyBaseline(db, migrations, options)),
      });
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}
