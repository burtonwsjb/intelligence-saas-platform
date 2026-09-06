import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { requireDatabaseAdminUrl } from "./env.js";
import { assertDisposableAdminUrl } from "./bootstrap-roles.js";
import { applyMigrations, readMigrationFiles } from "./migrate-lib.js";
import { NEON_SAMPLE_REFERENCE_SQL } from "./migration-neon-sample.js";

// Native PostgreSQL 16 and 18 CI run this only on disposable local databases.
describe("PostgreSQL baseline with an explicitly preserved Neon tutorial", () => {
  let root: ReturnType<typeof postgres>;
  let target: ReturnType<typeof postgres>;
  let url: string;
  let created = false;
  const name = `neon_profile_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    const adminUrl = requireDatabaseAdminUrl();
    assertDisposableAdminUrl(adminUrl);
    root = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => undefined });
    await root.unsafe(`CREATE DATABASE "${name}"`);
    created = true;
    const targetUrl = new URL(adminUrl);
    targetUrl.pathname = `/${name}`;
    url = targetUrl.toString();
    target = postgres(url, { max: 1, prepare: false, onnotice: () => undefined });
    const historical = (await readMigrationFiles()).filter((file) => file.name.slice(0, 4) <= "0023");
    await target.unsafe(historical.map((file) => file.sql).join("\n") + NEON_SAMPLE_REFERENCE_SQL).simple();
    await target`INSERT INTO "user" (id,name,email) VALUES ('preserve_neon','Existing','neon@example.invalid')`;
    await target`INSERT INTO public.playing_with_neon(name,value) VALUES ('existing_sample',3.5)`;
  });
  afterAll(async () => {
    await target?.end({ timeout: 5 });
    if (created) await root.unsafe(`DROP DATABASE "${name}"`);
    await root?.end({ timeout: 5 });
  });
  it("requires opt-in and returns the exact real prefix without target DDL or sequence updates", async () => {
    await expect(applyMigrations(url, { plan: true, detectBaseline: true })).rejects.toThrow(/No historical migration prefix matches/);
    const report = await applyMigrations(url, { plan: true, detectBaseline: true, includeNeonSample: true });
    expect(report).toMatchObject({ baselineCandidate: "0023_phase24_provider_runtime_grants.sql", applied: [], adopted: [], plan: true, preservedExternalProfiles: ["neon_sample.v1"] });
    expect(report.pending).toContain("0024_phase40_discovery.sql");
    expect((await target`SELECT to_regclass('public._isp_migration_history') AS ledger`)[0]?.ledger).toBeNull();
    expect((await target`SELECT name FROM public.playing_with_neon WHERE id=1`)[0]?.name).toBe("existing_sample");
    expect(Number((await target`SELECT last_value FROM public.playing_with_neon_id_seq`)[0]?.last_value)).toBe(1);
    expect((await target`SELECT id FROM "user" WHERE id='preserve_neon'`)[0]?.id).toBe("preserve_neon");
  });
  it("verifies the same profile for explicit adoption and migrates only pending application files", async () => {
    const before = (await target`SELECT 'public.playing_with_neon'::regclass::oid AS table_oid, 'public.playing_with_neon_id_seq'::regclass::oid AS sequence_oid`)[0];
    const report = await applyMigrations(url, { baselineThrough: "0023", confirmExistingSchema: true, includeNeonSample: true });
    expect(report.adopted.at(-1)).toBe("0023_phase24_provider_runtime_grants.sql");
    expect(report.applied).toEqual((await readMigrationFiles()).filter((file) => file.name.slice(0, 4) > "0023").map((file) => file.name));
    expect((await target`SELECT 'public.playing_with_neon'::regclass::oid AS table_oid, 'public.playing_with_neon_id_seq'::regclass::oid AS sequence_oid`)[0]).toEqual(before);
    expect((await target`SELECT name FROM public.playing_with_neon WHERE id=1`)[0]?.name).toBe("existing_sample");
    expect(Number((await target`SELECT last_value FROM public.playing_with_neon_id_seq`)[0]?.last_value)).toBe(1);
    expect((await target`SELECT id FROM "user" WHERE id='preserve_neon'`)[0]?.id).toBe("preserve_neon");
    expect((await applyMigrations(url)).applied).toEqual([]);
  });
});
