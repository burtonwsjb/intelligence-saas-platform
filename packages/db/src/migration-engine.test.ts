import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { migrateOnConnection, migrationChecksum, type MigrationConnection, type MigrationFile, type MigrationOptions } from "./migration-engine.js";
import { verifyLegacyBaseline } from "./migration-baseline.js";
import { migrationUrl, parseMigrationArgs } from "./migrate.js";

const clients: PGlite[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((c) => c.close())); });
function file(name: string, sql: string): MigrationFile { return { name, sql, checksum: migrationChecksum(sql) }; }
const first = file("0001_test.sql", 'CREATE TABLE public.demo (id text PRIMARY KEY);');
const second = file("0002_test.sql", 'ALTER TABLE public.demo ADD COLUMN title text;');
async function run(c: PGlite, files: MigrationFile[], options: MigrationOptions = {}) {
  return c.transaction(async (tx) => {
    const db: MigrationConnection = {
      query: async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => (await tx.query<T>(text, params)).rows,
      exec: async (text) => { await tx.exec(text); },
    };
    return migrateOnConnection(db, files, { ...options, verifyBaseline: verifyLegacyBaseline });
  });
}
function client() { const c = new PGlite(); clients.push(c); return c; }
describe("transactional migration history", () => {
  it("runs each migration once and applies only new migrations", async () => {
    const c = client();
    expect((await run(c, [first])).applied).toEqual([first.name]);
    await c.exec("INSERT INTO demo VALUES ('kept')");
    expect((await run(c, [first])).applied).toEqual([]);
    expect((await run(c, [first, second])).applied).toEqual([second.name]);
    expect((await c.query("SELECT id FROM demo")).rows).toEqual([{ id: "kept" }]);
  });
  it("detects checksum drift and Windows line endings do not create drift", async () => {
    const c = client();
    await run(c, [first]);
    await expect(run(c, [file(first.name, first.sql + " -- changed")])).rejects.toThrow(/history differs/);
    expect(migrationChecksum("a\r\nb")).toBe(migrationChecksum("a\nb"));
  });
  it("rolls back both DDL and ledger when a pending migration fails", async () => {
    const c = client();
    await run(c, [first]);
    await expect(run(c, [first, file("0002_bad.sql", "CREATE TABLE rollback_probe(id text); SELECT no_such_function();")])).rejects.toThrow();
    expect((await c.query("SELECT to_regclass('rollback_probe') AS name")).rows).toEqual([{ name: null }]);
    expect((await c.query("SELECT count(*)::int AS count FROM _isp_migration_history")).rows).toEqual([{ count: 1 }]);
  });
  it("does not write when planning", async () => {
    const c = client();
    expect((await run(c, [first], { plan: true })).pending).toEqual([first.name]);
    expect((await c.query("SELECT to_regclass('_isp_migration_history') AS name")).rows).toEqual([{ name: null }]);
  });
  it("refuses legacy replay and adopts only a schema verified in isolation", async () => {
    const c = client();
    await c.exec(first.sql);
    await expect(run(c, [first, second])).rejects.toThrow(/Refusing to replay/);
    const report = await run(c, [first, second], { baselineThrough: "0001", confirmExistingSchema: true });
    expect(report.adopted).toEqual([first.name]);
    expect(report.applied).toEqual([second.name]);
  });
  it("rejects a false baseline including constraints or unexpected objects", async () => {
    const c = client();
    await c.exec("CREATE TABLE public.demo (id text)");
    await expect(run(c, [first, second], { baselineThrough: "0001", confirmExistingSchema: true })).rejects.toThrow(/does not match/);
    expect((await c.query("SELECT to_regclass('_isp_migration_history') AS name")).rows).toEqual([{ name: null }]);
  });
  it("rejects runtime roles before any migration", async () => {
    const c = client();
    await c.exec("CREATE ROLE app_admin; SET ROLE app_admin;");
    await expect(run(c, [first])).rejects.toThrow(/Runtime database roles/);
  });
});
describe("migration CLI configuration", () => {
  it("requires a separate maintenance URL in hosted environments", () => {
    expect(() => migrationUrl({ ISP_ENV: "staging", DATABASE_ADMIN_URL: "postgresql://app_admin:secret@db/test" })).toThrow(/DATABASE_MIGRATE_URL/);
    expect(migrationUrl({ ISP_ENV: "staging", DATABASE_MIGRATE_URL: "postgresql://app_migrate:secret@db/test" })).toContain("app_migrate");
  });
  it("rejects malformed URLs without leaking them", () => {
    expect(() => migrationUrl({ DATABASE_MIGRATE_URL: 'DATABASE_MIGRATE_URL="postgresql://user:secret@db/test"' })).toThrow(/only a Postgres/);
  });
  it("accepts a bounded baseline only with explicit confirmation", () => {
    expect(parseMigrationArgs(["--", "--plan", "--baseline-through", "0023", "--confirm-existing-schema"])).toMatchObject({ plan: true, baselineThrough: "0023", confirmExistingSchema: true });
    expect(() => parseMigrationArgs(["--baseline-through", "0023"])).toThrow(/both/);
    expect(() => parseMigrationArgs(["--baseline-through", "../../bad", "--confirm-existing-schema"])).toThrow(/Unknown/);
  });
});
