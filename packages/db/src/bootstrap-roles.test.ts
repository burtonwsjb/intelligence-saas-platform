import { describe, expect, it } from "vitest";
import {
  assertDisposableAdminUrl,
  createMissingRoleSql,
  expectedRoleFlags,
  HostedTestDatabaseError,
  isHostedPostgresUrl,
  roleFlagsMatch,
  describeRoleMismatch,
  testRolePasswords,
  SUPABASE_API_ROLE_LOCKDOWN_SQL,
} from "./bootstrap-roles.js";

describe("application role invariants", () => {
  it("requires LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT and expected BYPASSRLS", () => {
    const migrate = expectedRoleFlags(true);
    const runtime = expectedRoleFlags(false);
    expect(migrate.rolcanlogin).toBe(true);
    expect(migrate.rolsuper).toBe(false);
    expect(migrate.rolcreatedb).toBe(false);
    expect(migrate.rolcreaterole).toBe(false);
    expect(migrate.rolinherit).toBe(false);
    expect(migrate.rolbypassrls).toBe(true);
    expect(runtime.rolbypassrls).toBe(false);
    expect(roleFlagsMatch(migrate, migrate)).toBe(true);
    expect(roleFlagsMatch(runtime, migrate)).toBe(false);
    expect(describeRoleMismatch(runtime, migrate)).toMatch(/NOBYPASSRLS \(need BYPASSRLS\)/);
  });

  it("creates missing roles without ALTER ROLE", () => {
    const sql = createMissingRoleSql("app_user", "secret'pass", { bypassRls: false });
    expect(sql).toMatch(/CREATE ROLE app_user LOGIN/);
    expect(sql).toMatch(/NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS/);
    expect(sql).toMatch(/PASSWORD 'secret''pass'/);
    expect(sql).not.toMatch(/ALTER ROLE/);
  });

  it("rejects Neon hosts for disposable isolation tests", () => {
    expect(isHostedPostgresUrl("postgresql://neondb_owner@ep-x.us-east-1.aws.neon.tech/neondb")).toBe(
      true,
    );
    expect(isHostedPostgresUrl("postgresql://isp:isp_dev_only@127.0.0.1:5432/isp")).toBe(false);
    expect(() =>
      assertDisposableAdminUrl("postgresql://neondb_owner@ep-x.us-east-1.aws.neon.tech/neondb"),
    ).toThrow(HostedTestDatabaseError);
  });

  it("rejects Supabase hosts for disposable isolation tests", () => {
    const direct = "postgresql://postgres@db.abcdefghijklmnopqrst.supabase.co:5432/postgres";
    const pooled = "postgresql://postgres.abcdefghijklmnopqrst@aws-0-us-east-1.pooler.supabase.com:6543/postgres";
    expect(isHostedPostgresUrl(direct)).toBe(true);
    expect(isHostedPostgresUrl(pooled)).toBe(true);
    expect(() => assertDisposableAdminUrl(pooled)).toThrow(HostedTestDatabaseError);
  });

  it("locks Supabase Data API roles out only where they exist", () => {
    expect(SUPABASE_API_ROLE_LOCKDOWN_SQL).toMatch(/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = api_role\)/);
    expect(SUPABASE_API_ROLE_LOCKDOWN_SQL).toMatch(/REVOKE ALL ON ALL TABLES IN SCHEMA public/);
    expect(SUPABASE_API_ROLE_LOCKDOWN_SQL).toMatch(/ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES/);
    expect(SUPABASE_API_ROLE_LOCKDOWN_SQL).not.toMatch(/service_role|GRANT /);
  });

  it("uses CI passwords unless APP_*_PASSWORD is set", () => {
    expect(testRolePasswords({}).user).toBe("isp_ci_app_user_only");
    expect(testRolePasswords({ APP_USER_PASSWORD: "from-env" }).user).toBe("from-env");
  });
});
