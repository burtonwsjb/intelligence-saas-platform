import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyMigrations, requireDatabaseAdminUrl } from "./index.js";

describe("migration smoke", () => {
  let admin: ReturnType<typeof postgres>;

  beforeAll(async () => {
    const url = requireDatabaseAdminUrl();
    await applyMigrations(url);
    admin = postgres(url, { max: 1, prepare: false });
  });

  afterAll(async () => {
    await admin.end({ timeout: 5 });
  });

  it("applies Phase 02-20 objects on an empty-capable database", async () => {
    const tables = await admin<{ relname: string }[]>`
      select relname
      from pg_class
      where relkind = 'r'
        and relnamespace = 'public'::regnamespace
        and relname in (
          'user', 'organization', 'tenant', 'api_key', 'source_event', 'outbox_job',
          'webhook_endpoint', 'platform_admins', 'platform_break_glass_audit',
          'tcg_prediction', 'content_publication'
        )
    `;
    expect(tables.map((row) => row.relname).sort()).toEqual(
      [
        "api_key",
        "content_publication",
        "organization",
        "outbox_job",
        "platform_admins",
        "platform_break_glass_audit",
        "source_event",
        "tcg_prediction",
        "tenant",
        "user",
        "webhook_endpoint",
      ].sort(),
    );
    const fns = await admin<{ proname: string }[]>`
      select proname from pg_proc
      where pronamespace = 'app'::regnamespace
        and proname in (
          'current_organization_id',
          'install_tenant_owned_rls',
          'forbid_platform_audit_mutate'
        )
    `;
    expect(fns.map((row) => row.proname).sort()).toEqual(
      ["current_organization_id", "forbid_platform_audit_mutate", "install_tenant_owned_rls"].sort(),
    );
  });
});
