import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  bootstrapRoles,
  createDbConnection,
  DB_ROLES,
  insertProductFeedback,
  productFeedback,
  replaceConnectionRole,
  requireDatabaseAdminUrl,
  withOrganizationContext,
  type Database,
} from "./index.js";

const passwords = {
  migrate: "isp_ci_migrate_only",
  user: "isp_ci_app_user_only",
  worker: "isp_ci_app_worker_only",
  admin: "isp_ci_app_admin_only",
};

describe("beta feedback RLS", () => {
  let adminUrl: string;
  let admin: ReturnType<typeof postgres>;
  let appConn: ReturnType<typeof createDbConnection>;
  let appDb: Database;

  beforeAll(async () => {
    adminUrl = requireDatabaseAdminUrl();
    await applyMigrations(adminUrl);
    await bootstrapRoles(adminUrl, passwords);
    admin = postgres(adminUrl, { max: 1, prepare: false });
    appConn = createDbConnection(replaceConnectionRole(adminUrl, DB_ROLES.user, passwords.user));
    appDb = appConn.db;
    await admin.unsafe(`
      INSERT INTO "user" (id, name, email, email_verified)
      VALUES ('beta_user_a', 'Beta A', 'beta-a@example.com', true),
             ('beta_user_b', 'Beta B', 'beta-b@example.com', true)
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO "organization" (id, name, slug)
      VALUES ('beta_org_a', 'Beta A', 'beta-org-a'),
             ('beta_org_b', 'Beta B', 'beta-org-b')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO "member" (id, organization_id, user_id, role)
      VALUES ('beta_mem_a', 'beta_org_a', 'beta_user_a', 'owner'),
             ('beta_mem_b', 'beta_org_b', 'beta_user_b', 'owner')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO "tenant" (organization_id, status, created_by_user_id)
      VALUES ('beta_org_a', 'active', 'beta_user_a'),
             ('beta_org_b', 'active', 'beta_user_b')
      ON CONFLICT (organization_id) DO UPDATE SET status = 'active';
    `);
  });

  afterAll(async () => {
    await appConn.end();
    await admin.end({ timeout: 5 });
  });

  it("keeps product feedback inside the writing tenant", async () => {
    await withOrganizationContext(
      appDb,
      { organizationId: "beta_org_a", userId: "beta_user_a" },
      (scoped) =>
        insertProductFeedback(scoped, {
          organizationId: "beta_org_a",
          userId: "beta_user_a",
          category: "api",
          message: "Quota messaging is confusing during ingest.",
        }),
    );
    const visibleToB = await withOrganizationContext(
      appDb,
      { organizationId: "beta_org_b", userId: "beta_user_b" },
      (scoped) =>
        scoped
          .select({ id: productFeedback.id })
          .from(productFeedback)
          .where(eq(productFeedback.organizationId, "beta_org_a")),
    );
    expect(visibleToB).toHaveLength(0);
  });
});
