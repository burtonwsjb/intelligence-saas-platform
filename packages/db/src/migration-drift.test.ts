import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { baselineDiagnostics, compareCatalogs, type CatalogSnapshot } from "./migration-drift.js";
import { detectLegacyBaseline, readCatalogSnapshot, verifyLegacyBaseline } from "./migration-baseline.js";
import { LegacySchemaMismatchError, migrateOnConnection, migrationChecksum, type MigrationConnection, type MigrationFile } from "./migration-engine.js";

const clients: PGlite[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())); });
function client() { const result = new PGlite(); clients.push(result); return result; }
function file(name: string, sql: string): MigrationFile { return { name, sql, checksum: migrationChecksum(sql) }; }
const first = file("0001_example.sql", "CREATE TABLE public.demo (id text PRIMARY KEY, title text NOT NULL DEFAULT 'initial'); CREATE TABLE public.child(id text REFERENCES public.demo(id));");
const second = file("0002_example.sql", "ALTER TABLE public.demo ADD COLUMN later integer;");
const empty = (): CatalogSnapshot => ({ relations: [], columns: [], constraints: [], indexes: [], policies: [], triggers: [], functions: [] });
async function transaction<T>(c: PGlite, fn: (db: MigrationConnection) => Promise<T>, readOnly = false): Promise<T> {
  return c.transaction(async (tx) => {
    if (readOnly) await tx.exec("SET TRANSACTION READ ONLY");
    return fn({
      query: async <R extends Record<string, unknown>>(text: string, params: unknown[] = []) => (await tx.query<R>(text, params)).rows,
      exec: async (text) => { await tx.exec(text); },
    });
  });
}

describe("safe schema drift diagnostics", () => {
  it("identifies changed/missing/unexpected objects without exposing SQL or arbitrary identifiers", () => {
    const expected = empty();
    expected.columns = [{ schema: "public", name: "demo", column_name: "title", default_value: "'initial'", required: true }];
    expected.functions = [{ schema: "app", name: "check_access", args: "", definition: "SELECT 1" }];
    const actual = structuredClone(expected);
    const secret = "postgresql://owner:NEVER_PRINT_ME@private.invalid/db";
    actual.columns[0]!.default_value = secret;
    actual.columns[0]!.required = false;
    actual.columns.push({ schema: "public", name: "demo", column_name: secret, default_value: secret });
    actual.functions = [{ schema: "app", name: secret, args: secret, definition: secret }];
    const report = baselineDiagnostics([compareCatalogs(expected, actual, first.name)]);
    expect(report.exactMatch).toBe(false);
    expect(report.groups.find((group) => group.catalog === "columns")).toMatchObject({ changed: 1, unexpected: 1 });
    expect(report.groups[0]!.examples[0]).toMatchObject({ object: "public.demo.title", fields: ["default_value", "required"] });
    const text = JSON.stringify(report);
    expect(text).toContain("app.check_access");
    for (const value of [secret, "NEVER_PRINT_ME", "private.invalid", "SELECT 1", "'initial'"]) expect(text).not.toContain(value);
  });
  it("bounds output, retains totals, and does not call a nearest candidate verified", () => {
    const expected = empty();
    const actual = empty();
    actual.relations = Array.from({ length: 50 }, (_, i) => ({ schema: "public", name: `external_${i}` }));
    const drift = compareCatalogs(expected, actual, first.name);
    expect(drift.differenceCount).toBe(50);
    expect(drift.groups[0]).toMatchObject({ unexpected: 50, examplesTruncated: true });
    expect(drift.groups[0]!.examples).toHaveLength(5);
    const report = baselineDiagnostics([drift, { ...drift, migration: second.name }]);
    expect(report.nearestCandidates[0]!.migration).toBe(second.name);
    expect(report.exactMatch).toBe(false);
  });
  it("does not collapse duplicate catalog keys or ignore changed definitions", () => {
    const expected = empty();
    expected.constraints = [{ schema: "public", name: "demo", constraint_name: "demo_check", definition: "CHECK (true)", validated: true, enforced: true }];
    const actual = structuredClone(expected);
    actual.constraints.push({ ...actual.constraints[0]! });
    expect(compareCatalogs(expected, actual, first.name).differenceCount).toBeGreaterThan(0);
    actual.constraints = [{ ...expected.constraints[0]!, validated: false }];
    expect(compareCatalogs(expected, actual, first.name).groups[0]!.examples[0]!.fields).toEqual(["validated"]);
    actual.constraints = [{ ...expected.constraints[0]!, enforced: false }];
    expect(compareCatalogs(expected, actual, first.name).groups[0]!.examples[0]!.fields).toEqual(["enforced"]);
  });
  it("normalizes search-path-dependent deparsing and restores the original path", async () => {
    const c = client();
    await c.exec(first.sql);
    await transaction(c, async (db) => {
      await db.query("SELECT set_config('search_path', 'pg_catalog', true)");
      const qualified = await db.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='child_id_fkey'");
      await db.query("SELECT set_config('search_path', 'public', true)");
      const unqualified = await db.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='child_id_fkey'");
      // Proves that the original byte-for-byte comparator could reject the
      // identical schema solely because the hosted session has another path.
      expect(qualified).not.toEqual(unqualified);
      await db.query("SELECT set_config('search_path', 'pg_catalog', true)");
      await verifyLegacyBaseline(db, [first]);
      expect((await db.query("SELECT current_setting('search_path') AS path"))[0]!.path).toBe("pg_catalog");
    }, true);
  });
  it("finds an exact prefix using one target snapshot and makes no persistent writes", async () => {
    const c = client();
    await c.exec(first.sql + "INSERT INTO demo (id) VALUES ('preserve_me')");
    let targetCatalogReads = 0;
    const report = await transaction(c, async (db) => {
      const original = db.query;
      db.query = async (text, params) => {
        if (/FROM pg_(class|attribute|constraint|indexes|policies|trigger|proc)\b/.test(text)) targetCatalogReads += 1;
        return original(text, params);
      };
      return migrateOnConnection(db, [first, second], { plan: true, detectBaseline: true, inspectBaseline: detectLegacyBaseline });
    }, true);
    expect(report).toMatchObject({ baselineCandidate: first.name, pending: [second.name], adopted: [], applied: [], plan: true });
    expect(targetCatalogReads).toBe(9); // Seven snapshot groups, table inventory, and pending ALTER ownership.
    expect((await c.query("SELECT id FROM demo")).rows).toEqual([{ id: "preserve_me" }]);
    expect((await c.query("SELECT to_regclass('public._isp_migration_history') AS ledger")).rows).toEqual([{ ledger: null }]);
  });
  it("reports real differences and refuses to turn a near match into a baseline", async () => {
    const c = client();
    await c.exec(first.sql + "ALTER TABLE demo ALTER COLUMN title DROP NOT NULL");
    const error = await transaction(c, (db) => migrateOnConnection(db, [first, second], {
      plan: true, detectBaseline: true, inspectBaseline: detectLegacyBaseline,
    }), true).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(LegacySchemaMismatchError);
    const diagnostic = (error as LegacySchemaMismatchError).diagnostics!;
    expect(diagnostic).toMatchObject({ exactMatch: false, comparisonAgainst: first.name });
    expect(diagnostic.groups.find((group) => group.catalog === "columns")?.examples).toContainEqual({ change: "changed", object: "public.demo.title", fields: ["required"] });
    expect((await c.query("SELECT to_regclass('public._isp_migration_history') AS ledger")).rows).toEqual([{ ledger: null }]);
  });
  it("restores catalog context even when a comparison finds drift", async () => {
    const c = client();
    await c.exec(first.sql);
    await transaction(c, async (db) => {
      const before = await db.query("SELECT current_setting('search_path') AS path");
      const snapshot = await readCatalogSnapshot(db);
      expect(snapshot.relations.length).toBe(2);
      await expect(verifyLegacyBaseline(db, [first, second])).rejects.toBeInstanceOf(LegacySchemaMismatchError);
      expect(await db.query("SELECT current_setting('search_path') AS path")).toEqual(before);
    });
  });
});
