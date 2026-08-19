import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  applyMigrations,
  bootstrapRoles,
  createDbConnection,
  DB_ROLES,
  deleteTenantResource,
  insertAuditEvent,
  insertTenantResource,
  listAuditEvents,
  listTenantResources,
  replaceConnectionRole,
  requireDatabaseAdminUrl,
  updateTenantResource,
  withOrganizationContext,
  type Database,
} from "./index.js";

const passwords = {
  migrate: "isp_ci_migrate_only",
  user: "isp_ci_app_user_only",
  worker: "isp_ci_app_worker_only",
  admin: "isp_ci_app_admin_only",
};

const ids = {
  userA: "user_a",
  userB: "user_b",
  userAB: "user_ab",
  orgA: "org_a",
  orgB: "org_b",
  resourceA: "res_a",
  resourceB: "res_b",
};

function idsFromExecute(result: unknown): string[] {
  const rows = Array.isArray(result)
    ? result
    : result && typeof result === "object" && "rows" in result
      ? (result as { rows: unknown[] }).rows
      : Array.from(result as Iterable<unknown>);
  return rows.map((row) => (row as { id: string }).id);
}

describe("PostgreSQL RLS isolation", () => {
  let adminUrl: string;
  let admin: ReturnType<typeof postgres>;
  let appConn: ReturnType<typeof createDbConnection>;
  let appDb: Database;

  beforeAll(async () => {
    adminUrl = requireDatabaseAdminUrl();
    await applyMigrations(adminUrl);
    await bootstrapRoles(adminUrl, passwords);
    admin = postgres(adminUrl, { max: 1, prepare: false });
    appConn = createDbConnection(
      replaceConnectionRole(adminUrl, DB_ROLES.user, passwords.user),
    );
    appDb = appConn.db;

    await admin.unsafe(`
      INSERT INTO "user" (id, name, email, email_verified)
      VALUES
        ('${ids.userA}', 'User A', 'a@example.com', true),
        ('${ids.userB}', 'User B', 'b@example.com', true),
        ('${ids.userAB}', 'User AB', 'ab@example.com', true)
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO "organization" (id, name, slug)
      VALUES
        ('${ids.orgA}', 'Org A', 'org-a'),
        ('${ids.orgB}', 'Org B', 'org-b')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO "member" (id, organization_id, user_id, role)
      VALUES
        ('mem_a', '${ids.orgA}', '${ids.userA}', 'owner'),
        ('mem_b', '${ids.orgB}', '${ids.userB}', 'owner'),
        ('mem_ab_a', '${ids.orgA}', '${ids.userAB}', 'admin'),
        ('mem_ab_b', '${ids.orgB}', '${ids.userAB}', 'admin')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO "tenant" (organization_id, status, created_by_user_id)
      VALUES
        ('${ids.orgA}', 'active', '${ids.userA}'),
        ('${ids.orgB}', 'active', '${ids.userB}')
      ON CONFLICT (organization_id) DO UPDATE SET status = 'active';
      INSERT INTO "tenant_resource" (id, organization_id, title)
      VALUES
        ('${ids.resourceA}', '${ids.orgA}', 'Alpha'),
        ('${ids.resourceB}', '${ids.orgB}', 'Beta')
      ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title;
    `);
  }, 60_000);

  afterAll(async () => {
    await appConn?.end();
    await admin?.end({ timeout: 5 });
  });

  async function asUser<T>(
    userId: string,
    organizationId: string,
    run: (db: Database) => Promise<T>,
  ): Promise<T> {
    return withOrganizationContext(appDb, { userId, organizationId }, run);
  }

  it("lets tenant A read A and not B", async () => {
    const rows = await asUser(ids.userA, ids.orgA, (db) =>
      listTenantResources(db, ids.orgA),
    );
    expect(rows.map((row) => row.id)).toEqual([ids.resourceA]);
    const hop = await asUser(ids.userA, ids.orgA, (db) =>
      listTenantResources(db, ids.orgB),
    );
    expect(hop).toEqual([]);
  });

  it("prevents A from inserting, updating, or deleting B", async () => {
    await expect(
      asUser(ids.userA, ids.orgA, (db) =>
        insertTenantResource(db, {
          id: "res_hop",
          organizationId: ids.orgB,
          title: "hop",
        }),
      ),
    ).rejects.toThrow();

    await expect(
      asUser(ids.userA, ids.orgA, (db) =>
        updateTenantResource(db, {
          id: ids.resourceB,
          organizationId: ids.orgB,
          title: "hacked",
        }),
      ),
    ).resolves.toBe(0);

    await expect(
      asUser(ids.userA, ids.orgA, (db) =>
        deleteTenantResource(db, { id: ids.resourceB, organizationId: ids.orgB }),
      ),
    ).resolves.toBe(0);
  });

  it("prevents B from reading A", async () => {
    const rows = await asUser(ids.userB, ids.orgB, (db) =>
      listTenantResources(db, ids.orgA),
    );
    expect(rows).toEqual([]);
  });

  it("returns no tenant-owned rows without context", async () => {
    await expect(listTenantResources(appDb, ids.orgA)).rejects.toThrow(
      /Tenant context is required/,
    );
    const raw = postgres(replaceConnectionRole(adminUrl, DB_ROLES.user, passwords.user), {
      max: 1,
      prepare: false,
    });
    try {
      const rows = await raw`select id from tenant_resource`;
      expect(rows).toHaveLength(0);
    } finally {
      await raw.end({ timeout: 5 });
    }
  });

  it("fails closed for the wrong tenant context", async () => {
    const rows = await asUser(ids.userA, ids.orgB, (db) =>
      listTenantResources(db, ids.orgB),
    );
    expect(rows).toEqual([]);
  });

  it("limits a multi-org user to the active tenant only", async () => {
    const activeA = await asUser(ids.userAB, ids.orgA, (db) =>
      listTenantResources(db, ids.orgA),
    );
    expect(activeA.map((row) => row.id)).toEqual([ids.resourceA]);
    const leak = await asUser(ids.userAB, ids.orgA, (db) =>
      db.execute(sql`select id from tenant_resource`),
    );
    expect(idsFromExecute(leak)).toEqual([ids.resourceA]);

    const activeB = await asUser(ids.userAB, ids.orgB, (db) =>
      listTenantResources(db, ids.orgB),
    );
    expect(activeB.map((row) => row.id)).toEqual([ids.resourceB]);
  });

  it("ignores a client-supplied foreign organization id while scoped to A", async () => {
    const rows = await asUser(ids.userAB, ids.orgA, (db) =>
      listTenantResources(db, ids.orgB),
    );
    expect(rows).toEqual([]);
  });

  it("blocks tenant_resource access when the tenant is suspended or deleted", async () => {
    await admin`update tenant set status = 'suspended' where organization_id = ${ids.orgA}`;
    await expect(
      asUser(ids.userA, ids.orgA, (db) => listTenantResources(db, ids.orgA)),
    ).resolves.toEqual([]);
    await expect(
      asUser(ids.userA, ids.orgA, (db) =>
        insertTenantResource(db, {
          id: "res_suspended",
          organizationId: ids.orgA,
          title: "nope",
        }),
      ),
    ).rejects.toThrow();

    await admin`update tenant set status = 'deleted' where organization_id = ${ids.orgB}`;
    await expect(
      asUser(ids.userB, ids.orgB, (db) => listTenantResources(db, ids.orgB)),
    ).resolves.toEqual([]);

    await admin`update tenant set status = 'active' where organization_id in (${ids.orgA}, ${ids.orgB})`;
  });

  it("keeps the application role from bypassing RLS or escalating", async () => {
    const raw = postgres(replaceConnectionRole(adminUrl, DB_ROLES.user, passwords.user), {
      max: 1,
      prepare: false,
    });
    try {
      const [role] = await raw<
        { current_user: string; rolsuper: boolean; rolbypassrls: boolean }[]
      >`
        select current_user, rolsuper, rolbypassrls
        from pg_roles
        where rolname = current_user
      `;
      expect(role?.current_user).toBe(DB_ROLES.user);
      expect(role?.rolsuper).toBe(false);
      expect(role?.rolbypassrls).toBe(false);

      await expect(raw.unsafe(`set role ${DB_ROLES.migrate}`)).rejects.toThrow();
      await expect(raw.unsafe(`set role ${DB_ROLES.admin}`)).rejects.toThrow();
      await expect(
        raw.unsafe(`alter table tenant disable row level security`),
      ).rejects.toThrow();
      await expect(
        raw.unsafe(`alter policy tenant_select on tenant using (true)`),
      ).rejects.toThrow();
    } finally {
      await raw.end({ timeout: 5 });
    }
  });

  it("prevents the application role from rewriting audit history", async () => {
    await asUser(ids.userA, ids.orgA, (db) =>
      insertAuditEvent(db, {
        id: "audit_a",
        organizationId: ids.orgA,
        actorUserId: ids.userA,
        action: "organization.switch",
      }),
    );
    const events = await asUser(ids.userA, ids.orgA, (db) =>
      listAuditEvents(db, ids.orgA),
    );
    expect(events.some((event) => event.id === "audit_a")).toBe(true);

    const raw = postgres(replaceConnectionRole(adminUrl, DB_ROLES.user, passwords.user), {
      max: 1,
      prepare: false,
    });
    try {
      await expect(
        raw.unsafe(`update audit_event set action = 'forged' where id = 'audit_a'`),
      ).rejects.toThrow();
      await expect(raw.unsafe(`delete from audit_event where id = 'audit_a'`)).rejects.toThrow();
    } finally {
      await raw.end({ timeout: 5 });
    }
  });
});
