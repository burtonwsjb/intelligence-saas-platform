import { createHash } from "node:crypto";
import type { BaselineDiagnostics } from "./migration-drift.js";

/** The adapter runs every operation on one transaction-bound connection. */
export interface MigrationConnection {
  query: <T extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;
  exec: (text: string) => Promise<void>;
}
export type MigrationFile = { name: string; sql: string; checksum: string };
export type MigrationOptions = {
  plan?: boolean;
  detectBaseline?: boolean;
  includeNeonSample?: boolean;
  inspectBaseline?: (db: MigrationConnection, files: MigrationFile[]) => Promise<number>;
  baselineThrough?: string;
  confirmExistingSchema?: boolean;
  verifyBaseline?: (db: MigrationConnection, files: MigrationFile[]) => Promise<void>;
};
export class MigrationSafetyError extends Error {
  constructor(message: string) { super(message); this.name = "MigrationSafetyError"; }
}
export class LegacySchemaMismatchError extends MigrationSafetyError {
  constructor(message: string, readonly diagnostics?: BaselineDiagnostics) { super(message); this.name = "LegacySchemaMismatchError"; }
}
export function migrationChecksum(sql: string): string {
  // Git checkouts on Windows and Linux must describe the same migration.
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}
const LEDGER = "_isp_migration_history";

export async function migrateOnConnection(db: MigrationConnection, files: MigrationFile[], options: MigrationOptions = {}) {
  if (options.detectBaseline && (!options.plan || options.baselineThrough || options.confirmExistingSchema)) {
    throw new MigrationSafetyError("Automatic baseline detection is read-only and requires --plan without adoption arguments.");
  }
  if (options.includeNeonSample && !(options.detectBaseline || (options.baselineThrough && options.confirmExistingSchema))) {
    throw new MigrationSafetyError("The Neon sample profile is only valid for legacy baseline detection or explicitly confirmed adoption.");
  }
  const ordered = [...files].sort((a, b) => a.name.localeCompare(b.name));
  if (new Set(ordered.map((f) => f.name.slice(0, 4))).size !== ordered.length ||
      ordered.some((f) => !/^\d{4}_[A-Za-z0-9_-]+\.sql$/.test(f.name))) {
    throw new MigrationSafetyError("Migration filenames must have unique four-digit versions.");
  }
  // Transaction-level lock is safe on both direct and transaction-pooled Postgres.
  await db.query("SELECT pg_advisory_xact_lock(1769172992, 1)");
  const [who] = await db.query<{ role: string }>("SELECT current_user AS role");
  if (!who || ["app_user", "app_worker", "app_admin"].includes(who.role)) {
    throw new MigrationSafetyError("Runtime database roles cannot run migrations. Set DATABASE_MIGRATE_URL to the authorized schema migration connection, not a web, worker, or admin runtime URL.");
  }
  const [exists] = await db.query<{ present: boolean }>("SELECT to_regclass('public._isp_migration_history') IS NOT NULL AS present");
  if (!exists) throw new MigrationSafetyError("Could not inspect the migration ledger.");
  const recorded = exists.present
    ? await db.query<{ name: string; checksum: string }>(`SELECT name, checksum FROM public.${LEDGER} ORDER BY name`)
    : [];
  for (const [i, entry] of recorded.entries()) {
    if (entry.name !== ordered[i]?.name || entry.checksum !== ordered[i]?.checksum) {
      throw new MigrationSafetyError(`Migration history differs from this checkout at ${entry.name}. No SQL was replayed; restore the original migration files and investigate drift.`);
    }
  }
  let baseline: MigrationFile[] = [];
  if (recorded.length === 0) {
    const tables = await db.query<{ name: string }>(
      "SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','app') AND c.relkind IN ('r','p') AND c.relname <> $1 ORDER BY c.relname",
      [LEDGER],
    );
    if (tables.length > 0) {
      if (options.detectBaseline && options.inspectBaseline) {
        const count = await options.inspectBaseline(db, ordered);
        if (!Number.isInteger(count) || count < 1 || count > ordered.length) {
          throw new MigrationSafetyError("Baseline inspection did not return an exact historical prefix. No writes were made.");
        }
        baseline = ordered.slice(0, count);
      } else if (options.detectBaseline && options.verifyBaseline) {
        // Check newest to oldest against an isolated reference. A match only
        // proposes a baseline; this path cannot write or adopt history.
        for (let end = ordered.length; end > 0; end -= 1) {
          const candidate = ordered.slice(0, end);
          try {
            await options.verifyBaseline(db, candidate);
            baseline = candidate;
            break;
          } catch (error) {
            if (!(error instanceof LegacySchemaMismatchError)) throw error;
          }
        }
        if (!baseline.length) throw new MigrationSafetyError("No historical migration prefix matches this database. No writes were made. Review schema drift; do not force a baseline.");
      } else {
      if (!options.baselineThrough || !options.confirmExistingSchema || !options.verifyBaseline) {
        throw new MigrationSafetyError("Existing database has no migration ledger. Refusing to replay old SQL. Use --baseline-through <last-existing-version> --confirm-existing-schema only after reviewing the target; the runner must verify its schema against an isolated reference first.");
      }
      const end = ordered.findIndex((f) => f.name === options.baselineThrough || f.name.slice(0, 4) === options.baselineThrough);
      if (end < 0) throw new MigrationSafetyError("Requested legacy baseline is not a migration in this checkout.");
      baseline = ordered.slice(0, end + 1);
      await options.verifyBaseline(db, baseline);
      }
    } else if (options.baselineThrough) {
      throw new MigrationSafetyError("An empty database cannot adopt a legacy baseline.");
    }
  } else if (options.baselineThrough) {
    throw new MigrationSafetyError("A migration ledger already exists; legacy adoption is not allowed.");
  }
  if (options.includeNeonSample && !baseline.length) {
    throw new MigrationSafetyError("The Neon sample profile requires an untracked legacy database and an exact verified baseline.");
  }
  const pending = ordered.slice(recorded.length + baseline.length);
  // Catch the actual ownership issue before applying ANY pending migration.
  // No automatic grants, ownership transfer, or runtime-role elevation.
  if (pending.length > 0) {
    const [schema] = await db.query<{ allowed: boolean }>("SELECT has_schema_privilege(current_user, 'public', 'USAGE') AND has_schema_privilege(current_user, 'public', 'CREATE') AS allowed");
    if (!schema?.allowed) throw new MigrationSafetyError("The migration connection lacks USAGE/CREATE on schema public. No pending migrations were applied. Use the authorized schema owner or have an owner grant only the migration role the required access.");
    for (const file of pending) {
      for (const match of file.sql.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?((?:"[A-Za-z0-9_]+"|[A-Za-z_][A-Za-z0-9_]*)(?:\.(?:"[A-Za-z0-9_]+"|[A-Za-z_][A-Za-z0-9_]*))?)/gi)) {
        const relation = match[1]!.includes(".") ? match[1]! : `public.${match[1]}`;
        const [table] = await db.query<{ allowed: boolean }>(
          "SELECT (r.rolsuper OR pg_has_role(current_user, c.relowner, 'USAGE')) AS allowed FROM pg_class c JOIN pg_roles r ON r.rolname=current_user WHERE c.oid=to_regclass($1)",
          [relation],
        );
        if (table && !table.allowed) {
          throw new MigrationSafetyError(`${file.name} needs ownership rights on ${relation}. Use its existing schema owner for this maintenance run; do not broaden application permissions. No pending migrations were applied.`);
        }
      }
    }
  }
  const report = { role: who.role, baselineCandidate: baseline.at(-1)?.name ?? null, adopted: options.plan ? [] as string[] : baseline.map((f) => f.name), pending: pending.map((f) => f.name), applied: [] as string[], plan: options.plan === true, preservedExternalProfiles: options.includeNeonSample ? ["neon_sample.v1"] : [] as string[] };
  if (options.plan) return report;
  await db.exec(`CREATE TABLE IF NOT EXISTS public.${LEDGER} (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(),
    applied_by text NOT NULL DEFAULT current_user, method text NOT NULL CHECK (method IN ('executed','baseline'))
  ); REVOKE ALL ON TABLE public.${LEDGER} FROM PUBLIC;`);
  for (const file of baseline) {
    await db.query(`INSERT INTO public.${LEDGER} (name, checksum, method) VALUES ($1,$2,'baseline')`, [file.name, file.checksum]);
  }
  for (const file of pending) {
    await db.exec(file.sql);
    await db.query(`INSERT INTO public.${LEDGER} (name, checksum, method) VALUES ($1,$2,'executed')`, [file.name, file.checksum]);
    report.applied.push(file.name);
  }
  return report;
}
