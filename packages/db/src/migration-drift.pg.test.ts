import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { requireDatabaseAdminUrl } from "./env.js";
import { assertDisposableAdminUrl } from "./bootstrap-roles.js";
import { applyMigrations, readMigrationFiles } from "./migrate-lib.js";
import { LegacySchemaMismatchError } from "./migration-engine.js";

describe("read-only PostgreSQL baseline diagnostics", () => {
  let root: ReturnType<typeof postgres>;
  let target: ReturnType<typeof postgres>;
  let url: string;
  let created = false;
  const name = `drift_diagnostics_${randomUUID().replaceAll("-", "")}`;
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
    await target.unsafe(historical.map((file) => file.sql).join("\n")).simple();
    await target`INSERT INTO "user" (id,name,email) VALUES ('preserve_drift','Existing','drift@example.invalid')`;
  });
  afterAll(async () => {
    await target?.end({ timeout: 5 });
    if (created) await root.unsafe(`DROP DATABASE "${name}"`);
    await root?.end({ timeout: 5 });
  });
  it("detects the real historical prefix without adopting or migrating it", async () => {
    const report = await applyMigrations(url, { plan: true, detectBaseline: true });
    expect(report).toMatchObject({ baselineCandidate: "0023_phase24_provider_runtime_grants.sql", applied: [], adopted: [], plan: true });
    expect(report.pending).toContain("0024_phase40_discovery.sql");
    expect((await target`SELECT to_regclass('public._isp_migration_history') AS ledger`)[0]?.ledger).toBeNull();
    expect((await target`SELECT id FROM "user" WHERE id='preserve_drift'`)[0]?.id).toBe("preserve_drift");
  });
  it("reports schema drift without logging target default values or adopting the nearest prefix", async () => {
    await target`ALTER TABLE public.session ADD COLUMN drift_probe text DEFAULT 'DO_NOT_LOG_THIS_SENTINEL'`;
    try {
      const error: unknown = await applyMigrations(url, { plan: true, detectBaseline: true }).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(LegacySchemaMismatchError);
      const diagnostic = (error as LegacySchemaMismatchError).diagnostics!;
      expect(diagnostic.exactMatch).toBe(false);
      expect(diagnostic.comparisonAgainst).toBe("0023_phase24_provider_runtime_grants.sql");
      const columns = diagnostic.groups.find((group) => group.catalog === "columns");
      expect(columns?.unexpected).toBe(1);
      expect(columns?.examples[0]?.object).toMatch(/^public\.session\.\[unrecognized:/);
      expect(JSON.stringify(diagnostic)).not.toContain("DO_NOT_LOG_THIS_SENTINEL");
      expect((await target`SELECT to_regclass('public._isp_migration_history') AS ledger`)[0]?.ledger).toBeNull();
    } finally {
      // Disposable test DB only; never executed against hosted databases.
      await target`ALTER TABLE public.session DROP COLUMN drift_probe`;
    }
  });
  it("enforces read-only plans at the database level even if an inspector attempts a write", async () => {
    await expect(applyMigrations(url, {
      plan: true, detectBaseline: true,
      inspectBaseline: async (db) => {
        await db.exec("CREATE TABLE public.forbidden_plan_write(id text)");
        return 23;
      },
    })).rejects.toMatchObject({ code: "25006" });
    expect((await target`SELECT to_regclass('public.forbidden_plan_write') AS probe`)[0]?.probe).toBeNull();
    expect((await target`SELECT to_regclass('public._isp_migration_history') AS ledger`)[0]?.ledger).toBeNull();
  });
});
