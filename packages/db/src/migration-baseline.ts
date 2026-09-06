import type { MigrationConnection, MigrationFile } from "./migration-engine.js";
import { LegacySchemaMismatchError, MigrationSafetyError } from "./migration-engine.js";
import { baselineDiagnostics, compareCatalogs, type CandidateDrift, type CatalogGroup, type CatalogSnapshot } from "./migration-drift.js";

// Only schema catalogs are read from the target. Historical SQL is executed in
// the isolated reference, never against the existing database.
// PG18 NOT NULL catalog entries are compared via pg_attribute, including
// validation, so PostgreSQL 16/17/18 can be compared without dropping safety.
const QUERIES: Record<CatalogGroup, string> = {
  relations: `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN ('public','app') AND c.relkind IN ('r','p','v','m','S') AND c.relname <> '_isp_migration_history'`,
  columns: `SELECT n.nspname AS schema,c.relname AS name,a.attname AS column_name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS required,
   COALESCE((SELECT bool_and(nnc.convalidated) FROM pg_constraint nnc
     WHERE nnc.conrelid=c.oid AND nnc.contype='n' AND a.attnum=ANY(nnc.conkey)),true) AS nullability_validated,
   a.attidentity AS identity_kind,a.attgenerated AS generated_kind,pg_get_expr(d.adbin,d.adrelid) AS default_value
   FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
   WHERE n.nspname IN ('public','app') AND c.relkind IN ('r','p','v','m') AND a.attnum>0 AND NOT a.attisdropped AND c.relname <> '_isp_migration_history'`,
  constraints: `SELECT n.nspname AS schema,c.relname AS name,k.conname AS constraint_name,k.convalidated AS validated,
   COALESCE((to_jsonb(k)->>'conenforced')::boolean,true) AS enforced,
   pg_get_constraintdef(k.oid) AS definition
   FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN ('public','app') AND k.contype <> 'n' AND c.relname <> '_isp_migration_history'`,
  indexes: `SELECT schemaname AS schema,tablename AS name,indexname AS index_name,indexdef AS definition FROM pg_indexes
   WHERE schemaname IN ('public','app') AND tablename <> '_isp_migration_history'`,
  policies: `SELECT schemaname AS schema,tablename AS name,policyname,permissive,roles::text AS roles,cmd,qual,with_check FROM pg_policies WHERE schemaname IN ('public','app')`,
  triggers: `SELECT n.nspname AS schema,c.relname AS name,t.tgname AS trigger_name,pg_get_triggerdef(t.oid) AS definition
   FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN ('public','app')`,
  functions: `SELECT n.nspname AS schema,p.proname AS name,pg_get_function_identity_arguments(p.oid) AS args,pg_get_functiondef(p.oid) AS definition
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','app') AND p.prokind='f'
   AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')`,
};
export async function readCatalogSnapshot(db: MigrationConnection): Promise<CatalogSnapshot> {
  const [previous] = await db.query<{ path: string }>("SELECT pg_catalog.current_setting('search_path') AS path");
  if (!previous) throw new MigrationSafetyError("Could not inspect the catalog comparison context.");
  try {
    // pg_get_* output depends on visibility. Use the SAME transaction-local
    // path for both snapshots, restoring it before any migration can execute.
    await db.query("SELECT pg_catalog.set_config('search_path', $1, true)", ["pg_catalog, public, app"]);
    const snapshot = {} as CatalogSnapshot;
    for (const [group, query] of Object.entries(QUERIES)) snapshot[group as CatalogGroup] = await db.query(query);
    return snapshot;
  } finally {
    await db.query("SELECT pg_catalog.set_config('search_path', $1, true)", [previous.path]);
  }
}
export async function verifyLegacyBaseline(db: MigrationConnection, files: MigrationFile[]) {
  const { PGlite } = await import("@electric-sql/pglite");
  const reference = new PGlite();
  try {
    await reference.exec(files.map((f) => f.sql).join("\n"));
    const expected = await reference.transaction((tx) => readCatalogSnapshot({
      query: async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => (await tx.query<T>(text, params)).rows,
      exec: async (text) => { await tx.exec(text); },
    }));
    const actual = await readCatalogSnapshot(db);
    const difference = compareCatalogs(expected, actual, files.at(-1)!.name);
    if (difference.differenceCount) {
      throw new LegacySchemaMismatchError("Legacy schema does not match the requested baseline. No changes were committed; review the safe catalog differences, not a guessed baseline.", baselineDiagnostics([difference]));
    }
  } finally {
    await reference.close();
  }
}
/** Inspect the target once, and build all historical prefixes in ONE isolated
 * reference. A near match is only diagnostic; it can never authorize adoption. */
export async function detectLegacyBaseline(db: MigrationConnection, files: MigrationFile[]): Promise<number> {
  const actual = await readCatalogSnapshot(db);
  const { PGlite } = await import("@electric-sql/pglite");
  const reference = new PGlite();
  const candidates: CandidateDrift[] = [];
  let matchedPrefix = 0;
  try {
    for (const [i, file] of files.entries()) {
      await reference.exec(file.sql);
      const expected = await reference.transaction((tx) => readCatalogSnapshot({
        query: async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => (await tx.query<T>(text, params)).rows,
        exec: async (text) => { await tx.exec(text); },
      }));
      const difference = compareCatalogs(expected, actual, file.name);
      if (difference.differenceCount === 0) matchedPrefix = i + 1;
      candidates.push(difference);
    }
    if (matchedPrefix) return matchedPrefix;
    throw new LegacySchemaMismatchError("No historical migration prefix matches this database. No writes were made. The nearest comparisons below are diagnostics only, not valid baselines.", baselineDiagnostics(candidates));
  } finally {
    await reference.close();
  }
}
