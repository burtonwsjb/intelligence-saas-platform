import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { detectLegacyBaseline, readCatalogSnapshot, verifyLegacyBaseline } from "./migration-baseline.js";
import { compareCatalogs } from "./migration-drift.js";
import { migrateOnConnection, migrationChecksum, type MigrationConnection, type MigrationFile, type MigrationOptions } from "./migration-engine.js";
import { NEON_SAMPLE_REFERENCE_SQL } from "./migration-neon-sample.js";
import { parseMigrationArgs } from "./migrate.js";
import { readMigrationFiles } from "./migrate-lib.js";

const clients: PGlite[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((c) => c.close())); });
const firstSql = "CREATE TABLE public.demo (id text PRIMARY KEY, title text NOT NULL);";
const first: MigrationFile = { name: "0001_demo.sql", sql: firstSql, checksum: migrationChecksum(firstSql) };
const secondSql = "ALTER TABLE public.demo ADD COLUMN extra text;";
const second: MigrationFile = { name: "0002_demo.sql", sql: secondSql, checksum: migrationChecksum(secondSql) };
const profile = { includeNeonSample: true };
function client() { const c = new PGlite(); clients.push(c); return c; }
function connection(tx: Pick<PGlite, "query" | "exec">): MigrationConnection {
  return {
    query: async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => (await tx.query<T>(text, params)).rows,
    exec: async (text) => { await tx.exec(text); },
  };
}
async function run(c: PGlite, files: MigrationFile[], options: MigrationOptions) {
  return c.transaction(async (tx) => {
    if (options.plan) await tx.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    return migrateOnConnection(connection(tx), files, {
      ...options,
      inspectBaseline: (db, selected) => detectLegacyBaseline(db, selected, options),
      verifyBaseline: (db, selected) => verifyLegacyBaseline(db, selected, options),
    });
  });
}

describe("explicit, exact Neon tutorial schema profile", () => {
  it("reproduces all seven reported fingerprints without exposing any table rows", async () => {
    const c = client();
    await c.exec(firstSql);
    const expected = await c.transaction((tx) => readCatalogSnapshot(connection(tx)));
    await c.exec(NEON_SAMPLE_REFERENCE_SQL);
    const actual = await c.transaction((tx) => readCatalogSnapshot(connection(tx)));
    const diff = compareCatalogs(expected, actual, first.name);
    expect(diff.differenceCount).toBe(7);
    const hashes = diff.groups.flatMap((g) => g.examples.map((e) => e.object)).sort();
    expect(hashes).toEqual([
      "[unrecognized:9a0a8f21ee1a]", "[unrecognized:6bda0830a227]",
      "[unrecognized:0b28015a2aec]", "[unrecognized:6b369cbeb60b]", "[unrecognized:78b9bacf6632]",
      "[unrecognized:4b7f5948771f]", "[unrecognized:4b7f5948771f]",
    ].sort());
  });
  it("requires explicit opt-in, then detects an exact baseline in a read-only transaction", async () => {
    const c = client();
    await c.exec(firstSql + NEON_SAMPLE_REFERENCE_SQL);
    await c.exec("INSERT INTO public.demo VALUES ('keep','Existing'); INSERT INTO public.playing_with_neon(name,value) VALUES ('keep_sample',3.5)");
    await expect(run(c, [first, second], { plan: true, detectBaseline: true })).rejects.toThrow(/No historical migration prefix matches/);
    const report = await run(c, [first, second], { plan: true, detectBaseline: true, ...profile });
    expect(report).toMatchObject({ baselineCandidate: first.name, pending: [second.name], applied: [], adopted: [], plan: true, preservedExternalProfiles: ["neon_sample.v1"] });
    expect((await c.query("SELECT to_regclass('public._isp_migration_history') AS ledger")).rows).toEqual([{ ledger: null }]);
    expect((await c.query("SELECT * FROM public.playing_with_neon")).rows).toEqual([{ id: 1, name: "keep_sample", value: 3.5 }]);
    expect((await c.query("SELECT last_value FROM public.playing_with_neon_id_seq")).rows).toEqual([{ last_value: 1 }]);
  });
  it("verifies explicit adoption too and preserves sample rows/sequence while applying only pending SQL", async () => {
    const c = client();
    await c.exec(firstSql + NEON_SAMPLE_REFERENCE_SQL);
    await c.exec("INSERT INTO public.playing_with_neon(name,value) VALUES ('preserved',2.5)");
    const report = await run(c, [first, second], { baselineThrough: "0001", confirmExistingSchema: true, ...profile });
    expect(report.adopted).toEqual([first.name]);
    expect(report.applied).toEqual([second.name]);
    expect((await c.query("INSERT INTO public.playing_with_neon(name) VALUES ('second') RETURNING id")).rows).toEqual([{ id: 2 }]);
    expect((await c.query("SELECT name FROM public.playing_with_neon ORDER BY id")).rows).toEqual([{ name: "preserved" }, { name: "second" }]);
    expect((await run(c, [first, second], {})).applied).toEqual([]);
  });
  it.each([
    "ALTER TABLE public.demo ALTER COLUMN title DROP NOT NULL",
    "ALTER TABLE public.playing_with_neon ADD COLUMN unexpected text",
    "ALTER TABLE public.playing_with_neon ALTER COLUMN value TYPE numeric",
    "ALTER TABLE public.playing_with_neon ALTER COLUMN name DROP NOT NULL",
    "ALTER TABLE public.playing_with_neon ENABLE ROW LEVEL SECURITY",
    "CREATE TABLE public._isp_migration_unexpected(id text)",
    "ALTER SEQUENCE public.playing_with_neon_id_seq OWNED BY NONE",
    "ALTER SEQUENCE public.playing_with_neon_id_seq INCREMENT BY 2",
    "ALTER TABLE public.demo ADD COLUMN sample_id integer REFERENCES public.playing_with_neon(id)",
  ])("does not hide real drift: %s", async (drift) => {
    const c = client();
    await c.exec(firstSql + NEON_SAMPLE_REFERENCE_SQL + drift);
    await expect(run(c, [first, second], { baselineThrough: "0001", confirmExistingSchema: true, ...profile })).rejects.toThrow();
    expect((await c.query("SELECT to_regclass('public._isp_migration_history') AS ledger")).rows).toEqual([{ ledger: null }]);
  });
  it("refuses opt-in when the expected sample is missing", async () => {
    const c = client();
    await c.exec(firstSql);
    await expect(run(c, [first, second], { plan: true, detectBaseline: true, ...profile })).rejects.toThrow(/documented sample table/);
  });
  it("matches the real repository schema through 0023 plus the tutorial, not a fabricated baseline", async () => {
    const c = client();
    const files = await readMigrationFiles();
    const historical = files.filter((f) => f.name.slice(0, 4) <= "0023");
    await c.exec(historical.map((f) => f.sql).join("\n") + NEON_SAMPLE_REFERENCE_SQL);
    const result = await run(c, files, { plan: true, detectBaseline: true, ...profile });
    expect(result.baselineCandidate).toBe("0023_phase24_provider_runtime_grants.sql");
    expect(result.pending).toContain("0024_phase40_discovery.sql");
    expect(result.applied).toEqual([]);
  });
  it("does not authorize writes through the profile flag or accept a generic ignore flag", () => {
    expect(parseMigrationArgs(["--", "--plan", "--detect-baseline", "--include-neon-sample"])).toMatchObject({ plan: true, detectBaseline: true, ...profile });
    expect(() => parseMigrationArgs(["--include-neon-sample"])).toThrow(/only valid/);
    expect(() => parseMigrationArgs(["--detect-baseline", "--include-neon-sample"])).toThrow(/read-only/);
    expect(() => parseMigrationArgs(["--plan", "--detect-baseline", "--ignore-unknown"])).toThrow(/Unknown migration argument/);
  });
});
