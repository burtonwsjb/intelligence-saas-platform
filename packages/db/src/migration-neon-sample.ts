import { MigrationSafetyError, type MigrationConnection } from "./migration-engine.js";

export const NEON_SAMPLE_PROFILE = "neon_sample.v1";
// Documented provider example, not application DDL. Executed ONLY inside the
// isolated comparison reference, never on the target database.
// https://neon.com/blog/announcing-point-in-time-restore
export const NEON_SAMPLE_REFERENCE_SQL = `CREATE TABLE public.playing_with_neon (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, value REAL
);`;

export async function prepareNeonSampleReference(
  target: MigrationConnection,
  reference: { exec: (text: string) => Promise<unknown> },
  includeNeonSample = false,
): Promise<void> {
  if (!includeNeonSample) return;
  // The ordinary catalog comparison below still checks EVERY table, column,
  // default, constraint, index, RLS flag, policy, trigger and function. This
  // additional check verifies the serial sequence configuration/ownership,
  // which the generic relation catalog does not describe. Never read row data
  // or the sequence's live counter; both must be preserved untouched.
  const [sample] = await target.query<{ valid: boolean }>(`
    SELECT (
      t.relkind = 'r' AND t.relpersistence = 'p' AND t.reloftype = 0
      AND NOT t.relispartition AND s.relkind = 'S' AND s.relpersistence = 'p'
      AND q.seqtypid = 'pg_catalog.int4'::regtype
      AND q.seqstart = 1 AND q.seqincrement = 1 AND q.seqmin = 1
      AND q.seqmax = 2147483647 AND q.seqcache = 1 AND NOT q.seqcycle
      AND EXISTS (
        SELECT 1 FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_attribute a
          ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
        WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = s.oid
          AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.refobjid = t.oid
          AND d.deptype = 'a' AND a.attname = 'id' AND NOT a.attisdropped
      )
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i
        WHERE i.inhrelid = t.oid OR i.inhparent = t.oid)
    ) AS valid
    FROM pg_catalog.pg_class t
    JOIN pg_catalog.pg_class s ON s.oid = to_regclass('public.playing_with_neon_id_seq')
    JOIN pg_catalog.pg_sequence q ON q.seqrelid = s.oid
    WHERE t.oid = to_regclass('public.playing_with_neon')
  `);
  if (sample?.valid !== true) {
    throw new MigrationSafetyError("The explicit Neon sample profile requires the documented sample table and its unchanged owned serial sequence. No changes were made; do not force a baseline.");
  }
  // This is an exact reference addition, not a name-based ignore list. A
  // modified sample or any other extra object still produces schema drift.
  await reference.exec(NEON_SAMPLE_REFERENCE_SQL);
}
