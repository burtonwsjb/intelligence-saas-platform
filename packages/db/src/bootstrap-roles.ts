import postgres from "postgres";
import { DB_ROLES } from "./roles.js";

export type RolePasswords = {
  migrate: string;
  user: string;
  worker: string;
  admin: string;
};

function escapeLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function createRoleSql(
  role: string,
  password: string,
  options: { bypassRls: boolean },
): string {
  const bypass = options.bypassRls ? "BYPASSRLS" : "NOBYPASSRLS";
  return `
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
        CREATE ROLE ${role} LOGIN PASSWORD '${escapeLiteral(password)}'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT ${bypass};
      ELSE
        ALTER ROLE ${role} LOGIN PASSWORD '${escapeLiteral(password)}'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT ${bypass};
      END IF;
    END
    $$;
  `;
}

export async function bootstrapRoles(
  adminUrl: string,
  passwords: RolePasswords,
): Promise<void> {
  const sql = postgres(adminUrl, { max: 1, prepare: false });
  try {
    const database = (
      await sql<{ current_database: string }[]>`select current_database()`
    )[0]!.current_database;

    await sql.unsafe(createRoleSql(DB_ROLES.migrate, passwords.migrate, { bypassRls: true }));
    await sql.unsafe(createRoleSql(DB_ROLES.user, passwords.user, { bypassRls: false }));
    await sql.unsafe(createRoleSql(DB_ROLES.worker, passwords.worker, { bypassRls: false }));
    await sql.unsafe(createRoleSql(DB_ROLES.admin, passwords.admin, { bypassRls: true }));

    await sql.unsafe(`
      GRANT CONNECT ON DATABASE ${database} TO ${DB_ROLES.migrate}, ${DB_ROLES.user}, ${DB_ROLES.worker}, ${DB_ROLES.admin};
      GRANT USAGE ON SCHEMA public TO ${DB_ROLES.migrate}, ${DB_ROLES.user}, ${DB_ROLES.worker}, ${DB_ROLES.admin};
      GRANT USAGE ON SCHEMA app TO ${DB_ROLES.migrate}, ${DB_ROLES.user}, ${DB_ROLES.worker}, ${DB_ROLES.admin};
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      REVOKE CREATE ON SCHEMA public FROM ${DB_ROLES.user}, ${DB_ROLES.worker};
    `);

    const tables = [
      "user",
      "session",
      "account",
      "verification",
      "organization",
      "member",
      "invitation",
      "tenant",
      "audit_event",
      "tenant_resource",
      "plan",
      "plan_entitlement",
      "tenant_billing",
      "tenant_entitlement_override",
      "stripe_event",
      "api_key",
      "usage_event",
      "usage_month",
    ];
    for (const table of tables) {
      await sql.unsafe(`ALTER TABLE "${table}" OWNER TO ${DB_ROLES.migrate}`);
    }
    await sql.unsafe(`
      ALTER FUNCTION app.current_organization_id() OWNER TO ${DB_ROLES.migrate};
      ALTER FUNCTION app.current_user_id() OWNER TO ${DB_ROLES.migrate};
      ALTER FUNCTION app.current_principal_type() OWNER TO ${DB_ROLES.migrate};
      ALTER FUNCTION app.current_api_key_id() OWNER TO ${DB_ROLES.migrate};
      ALTER FUNCTION app.has_active_membership() OWNER TO ${DB_ROLES.migrate};
      ALTER FUNCTION app.tenant_is_active() OWNER TO ${DB_ROLES.migrate};
      ALTER FUNCTION app.has_machine_principal() OWNER TO ${DB_ROLES.migrate};
      ALTER FUNCTION app.has_system_principal() OWNER TO ${DB_ROLES.migrate};
      ALTER FUNCTION app.is_authorized_principal() OWNER TO ${DB_ROLES.migrate};
      ALTER FUNCTION app.lookup_api_key_by_prefix(text) OWNER TO ${DB_ROLES.migrate};
      ALTER FUNCTION app.claim_stripe_event(text, text, text, text) OWNER TO ${DB_ROLES.migrate};
      ALTER FUNCTION app.lookup_organization_by_stripe_customer(text) OWNER TO ${DB_ROLES.migrate};
    `);

    await sql.unsafe(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
        "user", "session", "account", "verification", "organization", "member", "invitation",
        "tenant", "tenant_resource", "tenant_billing", "tenant_entitlement_override",
        "api_key", "usage_event", "usage_month"
      TO ${DB_ROLES.user}, ${DB_ROLES.worker};
      GRANT SELECT ON TABLE "plan", "plan_entitlement" TO ${DB_ROLES.user}, ${DB_ROLES.worker};
      GRANT SELECT, INSERT ON TABLE "audit_event" TO ${DB_ROLES.user}, ${DB_ROLES.worker};
      REVOKE UPDATE, DELETE ON TABLE "audit_event" FROM ${DB_ROLES.user}, ${DB_ROLES.worker};
      REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE "stripe_event" FROM ${DB_ROLES.user}, ${DB_ROLES.worker};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${DB_ROLES.migrate}, ${DB_ROLES.admin};
      GRANT EXECUTE ON FUNCTION app.current_organization_id() TO ${DB_ROLES.user}, ${DB_ROLES.worker}, ${DB_ROLES.migrate}, ${DB_ROLES.admin};
      GRANT EXECUTE ON FUNCTION app.current_user_id() TO ${DB_ROLES.user}, ${DB_ROLES.worker}, ${DB_ROLES.migrate}, ${DB_ROLES.admin};
      GRANT EXECUTE ON FUNCTION app.current_principal_type() TO ${DB_ROLES.user}, ${DB_ROLES.worker}, ${DB_ROLES.migrate}, ${DB_ROLES.admin};
      GRANT EXECUTE ON FUNCTION app.current_api_key_id() TO ${DB_ROLES.user}, ${DB_ROLES.worker}, ${DB_ROLES.migrate}, ${DB_ROLES.admin};
      GRANT EXECUTE ON FUNCTION app.has_active_membership() TO ${DB_ROLES.user}, ${DB_ROLES.worker}, ${DB_ROLES.migrate}, ${DB_ROLES.admin};
      GRANT EXECUTE ON FUNCTION app.tenant_is_active() TO ${DB_ROLES.user}, ${DB_ROLES.worker}, ${DB_ROLES.migrate}, ${DB_ROLES.admin};
      GRANT EXECUTE ON FUNCTION app.has_machine_principal() TO ${DB_ROLES.user}, ${DB_ROLES.worker}, ${DB_ROLES.migrate}, ${DB_ROLES.admin};
      GRANT EXECUTE ON FUNCTION app.has_system_principal() TO ${DB_ROLES.user}, ${DB_ROLES.worker}, ${DB_ROLES.migrate}, ${DB_ROLES.admin};
      GRANT EXECUTE ON FUNCTION app.is_authorized_principal() TO ${DB_ROLES.user}, ${DB_ROLES.worker}, ${DB_ROLES.migrate}, ${DB_ROLES.admin};
      GRANT EXECUTE ON FUNCTION app.lookup_api_key_by_prefix(text) TO ${DB_ROLES.user}, ${DB_ROLES.worker};
      GRANT EXECUTE ON FUNCTION app.claim_stripe_event(text, text, text, text) TO ${DB_ROLES.user}, ${DB_ROLES.worker};
      GRANT EXECUTE ON FUNCTION app.lookup_organization_by_stripe_customer(text) TO ${DB_ROLES.user}, ${DB_ROLES.worker};
    `);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export function replaceConnectionRole(
  adminUrl: string,
  role: string,
  password: string,
): string {
  const url = new URL(adminUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}
