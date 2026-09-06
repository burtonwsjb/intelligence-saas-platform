import type { MigrationConnection, MigrationFile } from "./migration-engine.js";
import { MigrationSafetyError } from "./migration-engine.js";

// Compare schema structure, not data, role ownership, or timestamps. No schema
// from an existing hosted database is ever copied into the reference database.
// PostgreSQL 18 also represents NOT NULL in pg_constraint; 16/17 do not.
// Compare nullability using pg_attribute on both versions, never by the presence
// or automatically generated name of a version-specific NOT NULL constraint.
// https://www.postgresql.org/docs/18/catalog-pg-constraint.html
const QUERIES = [
  `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN ('public','app') AND c.relkind IN ('r','p','v','m','S') AND c.relname <> '_isp_migration_history'`,
  `SELECT n.nspname AS schema,c.relname AS name,a.attname AS column_name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS required,
   COALESCE((SELECT bool_and(nnc.convalidated) FROM pg_constraint nnc
     WHERE nnc.conrelid=c.oid AND nnc.contype='n' AND a.attnum=ANY(nnc.conkey)),true) AS nullability_validated,
   a.attidentity AS identity_kind,a.attgenerated AS generated_kind,pg_get_expr(d.adbin,d.adrelid) AS default_value
   FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
   WHERE n.nspname IN ('public','app') AND c.relkind IN ('r','p','v','m') AND a.attnum>0 AND NOT a.attisdropped AND c.relname <> '_isp_migration_history'`,
  `SELECT n.nspname AS schema,c.relname AS name,k.conname AS constraint_name,k.convalidated AS validated,
   COALESCE((to_jsonb(k)->>'conenforced')::boolean,true) AS enforced,
   pg_get_constraintdef(k.oid) AS definition
   FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN ('public','app') AND k.contype <> 'n' AND c.relname <> '_isp_migration_history'`,
  `SELECT schemaname AS schema,tablename AS name,indexname AS index_name,indexdef AS definition FROM pg_indexes
   WHERE schemaname IN ('public','app') AND tablename <> '_isp_migration_history'`,
  `SELECT schemaname AS schema,tablename AS name,policyname,permissive,roles::text AS roles,cmd,qual,with_check FROM pg_policies WHERE schemaname IN ('public','app')`,
  `SELECT n.nspname AS schema,c.relname AS name,t.tgname AS trigger_name,pg_get_triggerdef(t.oid) AS definition
   FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN ('public','app')`,
  `SELECT n.nspname AS schema,p.proname AS name,pg_get_function_identity_arguments(p.oid) AS args,pg_get_functiondef(p.oid) AS definition
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','app') AND p.prokind='f'
   AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')`,
];
function canonical(rows: Record<string, unknown>[]) {
  return rows.map((row) => JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a],[b]) => a.localeCompare(b)))))
    .sort();
}
export async function verifyLegacyBaseline(db: MigrationConnection, files: MigrationFile[]) {
  // PGlite is an existing developer dependency, used only by this explicit
  // maintenance command. The historical migrations run HERE, never on staging.
  const { PGlite } = await import("@electric-sql/pglite");
  const reference = new PGlite();
  try {
    await reference.exec(files.map((f) => f.sql).join("\n"));
    for (const [i, query] of QUERIES.entries()) {
      const expected = canonical((await reference.query(query)).rows as Record<string, unknown>[]);
      const actual = canonical(await db.query(query));
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        throw new MigrationSafetyError(`Legacy schema does not match baseline ${files.at(-1)?.name} (catalog group ${i + 1}). No baseline or application changes were committed. Review schema drift; do not guess a newer baseline.`);
      }
    }
  } finally {
    await reference.close();
  }
}
