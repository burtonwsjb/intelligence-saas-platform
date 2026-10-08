import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import {
  applyMigrations,
  assertDisposableAdminUrl,
  bootstrapRoles,
  createDbConnection,
  DB_ROLES,
  replaceConnectionRole,
  requireDatabaseAdminUrl,
  testRolePasswords,
  withOrganizationContext,
  withPlatformContext,
} from "../index.js";
import { listTenantCreatorList, requestCreatorFollow } from "./list.js";
import { addTenantTopic, listTenantTopics, syncWorkspaceTopics } from "../topics/topics.js";
import { scoreDueCreatorCalls } from "./due.js";

// The influencer list is workspace-private: RLS separates workspaces, the web
// role cannot call the worker's bridge functions, and the worker cannot read
// the list directly beyond what those functions return.
describe("workspace influencer list on PostgreSQL", () => {
  const passwords = testRolePasswords();
  const name = `creator_list_${randomUUID().replaceAll("-", "")}`;
  let root: ReturnType<typeof postgres>;
  let created = false;
  let appConn: ReturnType<typeof createDbConnection> | undefined;
  let workerConn: ReturnType<typeof createDbConnection> | undefined;

  beforeAll(async () => {
    const adminUrl = requireDatabaseAdminUrl();
    assertDisposableAdminUrl(adminUrl);
    root = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => undefined });
    await root.unsafe(`CREATE DATABASE "${name}"`);
    created = true;
    const target = new URL(adminUrl);
    target.pathname = `/${name}`;
    await applyMigrations(target.toString());
    await bootstrapRoles(target.toString(), passwords);
    const seed = postgres(target.toString(), { max: 1, prepare: false, onnotice: () => undefined });
    await seed.unsafe(`
      INSERT INTO "user" (id, name, email, email_verified) VALUES
        ('u_a', 'A', 'a@example.test', true), ('u_b', 'B', 'b@example.test', true);
      INSERT INTO organization (id, name, slug) VALUES ('o_a', 'A', 'o-a'), ('o_b', 'B', 'o-b');
      INSERT INTO member (id, organization_id, user_id, role) VALUES
        ('m_a', 'o_a', 'u_a', 'owner'), ('m_b', 'o_b', 'u_b', 'owner');
      INSERT INTO tenant (organization_id, status, created_by_user_id) VALUES
        ('o_a', 'active', 'u_a'), ('o_b', 'active', 'u_b');
    `);
    await seed.end({ timeout: 5 });
    appConn = createDbConnection(replaceConnectionRole(target.toString(), DB_ROLES.user, passwords.user));
    workerConn = createDbConnection(replaceConnectionRole(target.toString(), DB_ROLES.worker, passwords.worker));
  }, 120_000);

  afterAll(async () => {
    await appConn?.end();
    await workerConn?.end();
    if (created) await root.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    await root?.end({ timeout: 5 });
  });

  it("keeps each workspace's list private and bridges only pending handles to the worker", async () => {
    const app = appConn!.db;
    await withOrganizationContext(app, { organizationId: "o_a", userId: "u_a" }, (db) =>
      requestCreatorFollow(db, { organizationId: "o_a", userId: "u_a", input: "youtube.com/@alphachannel" }),
    );
    await withOrganizationContext(app, { organizationId: "o_b", userId: "u_b" }, (db) =>
      requestCreatorFollow(db, { organizationId: "o_b", userId: "u_b", input: "reddit.com/user/beta_user" }),
    );
    const seenByA = await withOrganizationContext(app, { organizationId: "o_a", userId: "u_a" }, listTenantCreatorList);
    expect(seenByA.map((row) => row.inputHandle)).toEqual(["@alphachannel"]);

    // A cannot write into B's list.
    await expect(
      withOrganizationContext(app, { organizationId: "o_a", userId: "u_a" }, (db) =>
        db.execute(sql`INSERT INTO tenant_creator_list (id, organization_id, platform, input_handle)
          VALUES ('x', 'o_b', 'youtube', '@sneaky')`),
      ),
    ).rejects.toThrow();

    // The web role cannot call the worker bridge.
    await expect(
      withOrganizationContext(app, { organizationId: "o_a", userId: "u_a" }, (db) =>
        db.execute(sql`SELECT * FROM app.list_pending_creator_follows('youtube', 5)`),
      ),
    ).rejects.toThrow();

    // The worker sees pending handles through the bridge, but not the table.
    const worker = workerConn!.db;
    const pending = await withPlatformContext(worker, (db) =>
      db.execute(sql`SELECT id, input_handle FROM app.list_pending_creator_follows('youtube', 5)`),
    );
    const pendingRows = (Array.isArray(pending) ? pending : (pending as unknown as { rows: unknown[] }).rows) as {
      input_handle: string;
    }[];
    expect(pendingRows.map((row) => row.input_handle)).toEqual(["@alphachannel"]);
    const direct = await withPlatformContext(worker, (db) => db.execute(sql`SELECT count(*)::int AS n FROM tenant_creator_list`));
    const directRows = (Array.isArray(direct) ? direct : (direct as unknown as { rows: unknown[] }).rows) as { n: number }[];
    expect(directRows[0]!.n).toBe(0);
  });

  it("keeps topics private and lets the worker read only the query text", async () => {
    const app = appConn!.db;
    await withOrganizationContext(app, { organizationId: "o_a", userId: "u_a" }, (db) =>
      addTenantTopic(db, { organizationId: "o_a", userId: "u_a", query: "Bitcoin" }),
    );
    const seenByB = await withOrganizationContext(app, { organizationId: "o_b", userId: "u_b" }, listTenantTopics);
    expect(seenByB).toEqual([]);
    await expect(
      withOrganizationContext(app, { organizationId: "o_a", userId: "u_a" }, (db) =>
        db.execute(sql`SELECT * FROM app.list_tracked_topic_queries(10)`),
      ),
    ).rejects.toThrow();
    const report = await syncWorkspaceTopics(workerConn!.db);
    expect(report.added).toBe(3);
    await expect(
      withPlatformContext(workerConn!.db, (db) => db.execute(sql`SELECT count(*) FROM tenant_topic`)),
    ).rejects.toThrow();
  });

  it("lets the worker role run scheduled call scoring under its own grants", async () => {
    const report = await withPlatformContext(workerConn!.db, (db) => scoreDueCreatorCalls(db, { exclusive: true }));
    expect(report).toMatchObject({ considered: 0, failed: 0, creatorsRecomputed: 0 });
  });
});
