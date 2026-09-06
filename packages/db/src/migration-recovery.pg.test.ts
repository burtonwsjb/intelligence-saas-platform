import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { requireDatabaseAdminUrl } from "./env.js";
import { assertDisposableAdminUrl, bootstrapRoles, replaceConnectionRole, testRolePasswords } from "./bootstrap-roles.js";
import { applyMigrations } from "./migrate-lib.js";
import { drizzleDirectory, listMigrationFiles } from "./migrations.js";

describe("PostgreSQL legacy migration recovery", () => {
  let root: ReturnType<typeof postgres>;
  let target: ReturnType<typeof postgres>;
  let url: string;
  let names: string[];
  const name = `migration_repair_${randomUUID().replaceAll("-", "")}`;
  let created = false;
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
    names = await listMigrationFiles();
    const historical = names.filter((n) => n.slice(0, 4) <= "0023");
    const oldSql = (await Promise.all(historical.map((n) => readFile(path.join(drizzleDirectory(), n), "utf8")))).join("\n");
    await target.unsafe(oldSql).simple();
    await target`INSERT INTO "user" (id,name,email) VALUES ('preserve_me','Before migration','before@example.invalid')`;
  });
  afterAll(async () => {
    await target?.end({ timeout: 5 });
    if (created) await root.unsafe(`DROP DATABASE "${name}"`);
    await root?.end({ timeout: 5 });
  });
  it("adopts the real historical schema and applies only new migrations", async () => {
    const plan = await applyMigrations(url, { plan: true, detectBaseline: true });
    expect(plan.baselineCandidate).toBe("0023_phase24_provider_runtime_grants.sql");
    expect(plan.applied).toEqual([]);
    expect((await target`SELECT to_regclass('public._isp_migration_history') AS name`)[0]?.name).toBeNull();
    const report = await applyMigrations(url, { baselineThrough: "0023", confirmExistingSchema: true });
    expect(report.adopted).toHaveLength(23);
    expect(report.applied).toEqual(names.filter((n) => n.slice(0, 4) > "0023"));
    expect((await target`SELECT id FROM "user" WHERE id='preserve_me'`)[0]?.id).toBe("preserve_me");
  });
  it("concurrent reruns do not replay historical SQL or duplicate the ledger", async () => {
    const [first, second] = await Promise.all([applyMigrations(url), applyMigrations(url)]);
    expect(first.applied).toEqual([]);
    expect(second.applied).toEqual([]);
    expect(Number((await target`SELECT count(*) AS n FROM _isp_migration_history`)[0]?.n)).toBe(names.length);
  });
  it("executes discovered-channel monitoring with the restricted worker role", async () => {
    const { createDbConnection } = await import("./client.js");
    const { runSocialDiscovery } = await import("./providers/discovery.js");
    const { runCreatorMonitoring } = await import("./providers/monitoring.js");
    const { sourceIntelligenceFixtures } = await import("./source/fixtures.js");
    const { applyProviderModeFromEnv } = await import("./providers/runtime.js");
    const { withPlatformContext } = await import("./rls.js");
    const passwords = testRolePasswords();
    await bootstrapRoles(url, passwords);
    const owner = createDbConnection(url);
    const worker = createDbConnection(replaceConnectionRole(url, "app_worker", passwords.worker));
    try {
      const env = { ISP_ENV: "test", PROVIDER_YOUTUBE_MODE: "live", YOUTUBE_API_KEY: "synthetic-test-key" };
      const record = sourceIntelligenceFixtures().find((r) => r.provider === "youtube")!;
      await runSocialDiscovery(owner.db, { providerKey: "youtube", query: "Pokemon TCG investing", env: { ISP_ENV: "test" },
        records: [{ ...record, content: { ...record.content, title: "Pokemon TCG investing buy hold market" } }],
      });
      await withPlatformContext(owner.db, (tx) => applyProviderModeFromEnv(tx, env));
      const report = await runCreatorMonitoring(worker.db, { providerKey: "youtube", env, transport: {
        async fetch(url) {
          const external = record.account.external_account_id;
          const items = url.includes("/channels?") ? [{ id: external, contentDetails: { relatedPlaylists: { uploads: "test_uploads" } } }]
            : url.includes("/playlistItems?") ? [{ contentDetails: { videoId: "test_new_upload" } }]
              : [{ id: "test_new_upload", snippet: { channelId: external, title: "Pokemon market update", publishedAt: "2026-09-01T00:00:00Z" }, statistics: { viewCount: "1000" } }];
          return { status: 200, headers: {}, bodyText: JSON.stringify({ items }) };
        },
      }});
      expect(report).toMatchObject({ status: "completed", received: 1, requests: 3 });
      expect((await target`SELECT rolbypassrls FROM pg_roles WHERE rolname='app_worker'`)[0]?.rolbypassrls).toBe(false);
    } finally {
      await owner.end();
      await worker.end();
    }
  });

});
