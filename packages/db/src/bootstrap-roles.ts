import postgres, { type Sql } from "postgres";
import { DB_ROLES } from "./roles.js";

export type RolePasswords = {
  migrate: string;
  user: string;
  worker: string;
  admin: string;
};

export type RoleFlags = {
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolinherit: boolean;
  rolbypassrls: boolean;
};

export class RoleInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleInvariantError";
  }
}

export class HostedTestDatabaseError extends Error {
  constructor() {
    super(
      "Isolation and integration tests must use disposable local or CI Postgres, not Neon.",
    );
    this.name = "HostedTestDatabaseError";
  }
}

function escapeLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

export function expectedRoleFlags(bypassRls: boolean): RoleFlags {
  return {
    rolcanlogin: true,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolinherit: false,
    rolbypassrls: bypassRls,
  };
}

export function describeRoleMismatch(actual: RoleFlags, expected: RoleFlags): string {
  const labels: [keyof RoleFlags, string, string][] = [
    ["rolcanlogin", "LOGIN", "NOLOGIN"],
    ["rolsuper", "SUPERUSER", "NOSUPERUSER"],
    ["rolcreatedb", "CREATEDB", "NOCREATEDB"],
    ["rolcreaterole", "CREATEROLE", "NOCREATEROLE"],
    ["rolinherit", "INHERIT", "NOINHERIT"],
    ["rolbypassrls", "BYPASSRLS", "NOBYPASSRLS"],
  ];
  return labels
    .filter(([key]) => actual[key] !== expected[key])
    .map(([key, whenTrue, whenFalse]) => `${actual[key] ? whenTrue : whenFalse} (need ${expected[key] ? whenTrue : whenFalse})`)
    .join(", ");
}

export function roleFlagsMatch(actual: RoleFlags, expected: RoleFlags): boolean {
  return describeRoleMismatch(actual, expected).length === 0;
}

export function createMissingRoleSql(
  role: string,
  password: string,
  options: { bypassRls: boolean },
): string {
  const bypass = options.bypassRls ? "BYPASSRLS" : "NOBYPASSRLS";
  return `CREATE ROLE ${role} LOGIN PASSWORD '${escapeLiteral(password)}'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT ${bypass}`;
}

export function correctRoleSql(
  role: string,
  password: string,
  options: { bypassRls: boolean },
): string {
  const bypass = options.bypassRls ? "BYPASSRLS" : "NOBYPASSRLS";
  return `ALTER ROLE ${role} LOGIN PASSWORD '${escapeLiteral(password)}'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT ${bypass}`;
}

export function isHostedPostgresUrl(url: string): boolean {
  try {
    return /\.neon\.tech$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function assertDisposableAdminUrl(url: string): void {
  if (isHostedPostgresUrl(url)) {
    throw new HostedTestDatabaseError();
  }
}

export function testRolePasswords(env: NodeJS.ProcessEnv = process.env): RolePasswords {
  return {
    migrate: env.APP_MIGRATE_PASSWORD?.trim() || "isp_ci_migrate_only",
    user: env.APP_USER_PASSWORD?.trim() || "isp_ci_app_user_only",
    worker: env.APP_WORKER_PASSWORD?.trim() || "isp_ci_app_worker_only",
    admin: env.APP_ADMIN_PASSWORD?.trim() || "isp_ci_app_admin_only",
  };
}

function isInsufficientPrivilege(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === "42501" ||
    /permission denied|must be able to SET ROLE|must be owner/i.test(message)
  );
}

async function currentUserIsSuperuser(sql: Sql): Promise<boolean> {
  const rows = await sql<{ rolsuper: boolean }[]>`
    SELECT rolsuper FROM pg_roles WHERE rolname = current_user
  `;
  return rows[0]?.rolsuper === true;
}

async function readRoleFlags(sql: Sql, role: string): Promise<RoleFlags | null> {
  const rows = await sql<RoleFlags[]>`
    SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolbypassrls
    FROM pg_roles
    WHERE rolname = ${role}
  `;
  return rows[0] ?? null;
}

async function ensureApplicationRole(
  sql: Sql,
  role: string,
  password: string,
  options: { bypassRls: boolean },
): Promise<void> {
  const expected = expectedRoleFlags(options.bypassRls);
  const existing = await readRoleFlags(sql, role);
  if (!existing) {
    await sql.unsafe(createMissingRoleSql(role, password, options));
    return;
  }
  if (roleFlagsMatch(existing, expected)) {
    return;
  }
  const mismatch = describeRoleMismatch(existing, expected);
  if (await currentUserIsSuperuser(sql)) {
    await sql.unsafe(correctRoleSql(role, password, options));
    return;
  }
  throw new RoleInvariantError(
    `Role ${role} exists but does not match required attributes: ${mismatch}. ` +
      "This provisioner cannot ALTER ROLE (Neon owners typically cannot). " +
      "Fix the role in the Neon SQL editor or recreate it with LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT and the expected BYPASSRLS/NOBYPASSRLS.",
  );
}

async function transferOwnerIfAllowed(sql: Sql, statement: string): Promise<void> {
  try {
    await sql.unsafe(statement);
  } catch (error) {
    if (isInsufficientPrivilege(error)) {
      return;
    }
    throw error;
  }
}

export async function bootstrapRoles(
  adminUrl: string,
  passwords: RolePasswords,
): Promise<void> {
  const sql = postgres(adminUrl, { max: 1, prepare: false });
  try {
    await ensureApplicationRole(sql, DB_ROLES.migrate, passwords.migrate, { bypassRls: true });
    await ensureApplicationRole(sql, DB_ROLES.user, passwords.user, { bypassRls: false });
    await ensureApplicationRole(sql, DB_ROLES.worker, passwords.worker, { bypassRls: false });
    await ensureApplicationRole(sql, DB_ROLES.admin, passwords.admin, { bypassRls: true });

    await sql.unsafe(`
      DO $grant$
      BEGIN
        EXECUTE format(
          'GRANT CONNECT ON DATABASE %I TO %I, %I, %I, %I',
          current_database(),
          '${DB_ROLES.migrate}',
          '${DB_ROLES.user}',
          '${DB_ROLES.worker}',
          '${DB_ROLES.admin}'
        );
      EXCEPTION
        WHEN insufficient_privilege THEN
          NULL;
      END
      $grant$;
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
      "source_event",
      "outbox_job",
      "source_definition",
      "entity",
      "entity_identifier",
      "observation",
      "observation_metric",
      "evidence_reference",
      "feature_snapshot",
      "signal",
      "signal_evidence",
      "decision_record",
      "decision_evidence",
      "tcg_game",
      "tcg_language",
      "tcg_set",
      "tcg_card_concept",
      "tcg_printing",
      "tcg_printing_identifier",
      "tcg_identifier_conflict",
      "tcg_market_source",
      "tcg_market_ingest",
      "tcg_market_snapshot",
      "tcg_market_quarantine",
      "tcg_market_revision",
      "source_platform",
      "source_account",
      "source_ingest",
      "source_content",
      "source_content_segment",
      "source_mention",
      "source_engagement_snapshot",
      "tcg_card_name_alias",
      "entity_resolution_attempt",
      "entity_resolution_candidate",
      "entity_resolution_correction",
      "creator",
      "creator_source_account",
      "creator_call",
      "creator_call_outcome",
      "creator_authority_slice",
      "creator_trust_event",
      "tcg_market_feature_snapshot",
      "tcg_index_definition",
      "tcg_index_membership",
      "tcg_index_level",
      "creator_call_alpha",
      "tcg_score_snapshot",
      "tcg_prediction",
      "tcg_prediction_outcome",
      "tcg_backtest_run",
      "webhook_endpoint",
      "webhook_delivery",
      "crm_organization_profile",
      "crm_user_profile",
      "crm_lifecycle_transition",
      "crm_customer_event",
      "crm_operator_note",
      "crm_tag",
      "crm_organization_tag",
      "crm_segment_definition",
      "crm_segment_membership",
      "crm_churn_reason",
      "notification_preference",
      "email_delivery",
      "in_app_notification",
      "alert_rule",
      "usage_warning",
      "content_candidate",
      "content_evidence_package",
      "content_draft",
      "content_claim",
      "content_validation",
      "content_publication",
      "tenant_content_report",
      "platform_admins",
      "platform_break_glass_audit",
      "platform_support_case",
      "platform_feature_flags",
      "beta_invitation",
      "beta_organization",
      "product_feedback",
      "bug_report",
      "product_event",
      "provider_runtime",
      "provider_sync_run",
      "platform_outbox",
      "source_sentiment",
      "intelligence_quarantine",
      "tcg_market_quarantine_review",
      "worker_heartbeat",
    ];
    for (const table of tables) {
      await transferOwnerIfAllowed(
        sql,
        `ALTER TABLE "${table}" OWNER TO ${DB_ROLES.migrate}`,
      );
    }
    const functions = [
      "app.current_organization_id()",
      "app.current_user_id()",
      "app.current_principal_type()",
      "app.current_api_key_id()",
      "app.has_active_membership()",
      "app.tenant_is_active()",
      "app.has_machine_principal()",
      "app.has_system_principal()",
      "app.is_authorized_principal()",
      "app.lookup_api_key_by_prefix(text)",
      "app.claim_stripe_event(text, text, text, text)",
      "app.lookup_organization_by_stripe_customer(text)",
      "app.list_pending_outbox(integer)",
      "app.forbid_analytical_mutate()",
      "app.protect_entity()",
      "app.protect_decision_record()",
      "app.install_kernel_rls(text, boolean)",
      "app.forbid_tcg_canonical_mutate()",
      "app.forbid_tcg_market_mutate()",
      "app.require_system_tcg_market_write()",
      "app.forbid_analytics_mutate()",
      "app.require_system_analytics_write()",
      "app.close_index_membership()",
      "app.forbid_source_mutate()",
      "app.require_system_source_write()",
      "app.forbid_resolution_mutate()",
      "app.require_system_resolution_write()",
      "app.forbid_creator_call_mutate()",
      "app.require_system_creator_write()",
      "app.install_tenant_owned_rls(text, boolean)",
      "app.install_operator_only_rls(text)",
      "app.forbid_platform_audit_mutate()",
      "app.consume_beta_invite(text, text)",
      "app.require_system_provider_write()",
      "app.list_pending_platform_outbox(integer)",
    ];
    for (const fn of functions) {
      await transferOwnerIfAllowed(sql, `ALTER FUNCTION ${fn} OWNER TO ${DB_ROLES.migrate}`);
    }

    await sql.unsafe(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
        "user", "session", "account", "verification", "organization", "member", "invitation",
        "tenant", "tenant_resource", "tenant_billing", "tenant_entitlement_override",
        "api_key", "usage_event", "usage_month", "source_event", "outbox_job", "entity",
        "webhook_endpoint", "webhook_delivery",
        "crm_organization_profile", "crm_user_profile", "crm_lifecycle_transition",
        "crm_customer_event", "crm_churn_reason", "notification_preference",
        "email_delivery", "in_app_notification", "alert_rule", "usage_warning"
      TO ${DB_ROLES.user}, ${DB_ROLES.worker};
      GRANT SELECT, INSERT ON TABLE
        "entity_identifier", "observation", "observation_metric", "evidence_reference",
        "feature_snapshot", "signal", "signal_evidence", "decision_record", "decision_evidence"
      TO ${DB_ROLES.user}, ${DB_ROLES.worker};
      GRANT UPDATE ON TABLE "decision_record" TO ${DB_ROLES.user}, ${DB_ROLES.worker};
      REVOKE DELETE ON TABLE "entity" FROM ${DB_ROLES.user}, ${DB_ROLES.worker};
      GRANT SELECT ON TABLE "plan", "plan_entitlement", "source_definition" TO ${DB_ROLES.user}, ${DB_ROLES.worker};
      GRANT SELECT ON TABLE
        "tcg_game", "tcg_language", "tcg_set", "tcg_card_concept",
        "tcg_printing", "tcg_printing_identifier", "tcg_identifier_conflict",
        "tcg_market_source", "tcg_market_ingest", "tcg_market_snapshot",
        "tcg_market_quarantine", "tcg_market_revision",
        "source_platform", "source_account", "source_ingest", "source_content",
        "source_content_segment", "source_mention", "source_engagement_snapshot",
        "tcg_card_name_alias", "entity_resolution_attempt", "entity_resolution_candidate",
        "entity_resolution_correction",
        "creator", "creator_source_account", "creator_call", "creator_call_outcome",
        "creator_authority_slice", "creator_trust_event",
        "tcg_market_feature_snapshot", "tcg_index_definition", "tcg_index_membership",
        "tcg_index_level", "creator_call_alpha", "tcg_score_snapshot",
        "tcg_prediction",
      "tcg_prediction_outcome",
      "tcg_backtest_run",
      "content_candidate",
      "content_evidence_package",
      "content_draft",
      "content_claim",
      "content_validation",
      "content_publication"
      TO ${DB_ROLES.user}, ${DB_ROLES.worker};
      REVOKE INSERT, UPDATE, DELETE ON TABLE
        "tcg_game", "tcg_language", "tcg_set", "tcg_card_concept",
        "tcg_printing", "tcg_printing_identifier", "tcg_identifier_conflict",
        "tcg_market_source", "tcg_card_name_alias"
      FROM ${DB_ROLES.user}, ${DB_ROLES.worker};
      REVOKE INSERT, UPDATE, DELETE ON TABLE
        "source_platform"
      FROM ${DB_ROLES.user}, ${DB_ROLES.worker};
      GRANT SELECT, INSERT, UPDATE ON TABLE "source_account", "source_ingest" TO ${DB_ROLES.worker};
      GRANT SELECT, INSERT ON TABLE
        "source_content", "source_content_segment", "source_mention", "source_engagement_snapshot",
        "entity_resolution_attempt", "entity_resolution_candidate", "entity_resolution_correction",
        "creator", "creator_source_account", "creator_call", "creator_call_outcome",
        "creator_authority_slice", "creator_trust_event"
      TO ${DB_ROLES.worker};
      GRANT SELECT, INSERT, UPDATE ON TABLE "creator", "creator_call_outcome" TO ${DB_ROLES.worker};
      REVOKE INSERT, UPDATE, DELETE ON TABLE
        "source_account", "source_ingest", "source_content", "source_content_segment",
        "source_mention", "source_engagement_snapshot",
        "tcg_card_name_alias", "entity_resolution_attempt", "entity_resolution_candidate",
        "entity_resolution_correction",
        "creator", "creator_source_account", "creator_call", "creator_call_outcome",
        "creator_authority_slice", "creator_trust_event",
        "tcg_market_feature_snapshot", "tcg_index_definition", "tcg_index_membership",
        "tcg_index_level", "creator_call_alpha", "tcg_score_snapshot",
      "tcg_prediction",
      "tcg_prediction_outcome",
      "tcg_backtest_run"
      FROM ${DB_ROLES.user};
      REVOKE UPDATE, DELETE ON TABLE
        "source_content", "source_content_segment", "source_mention", "source_engagement_snapshot",
        "entity_resolution_attempt", "entity_resolution_candidate", "entity_resolution_correction",
        "creator_source_account", "creator_call",
        "creator_authority_slice", "creator_trust_event"
      FROM ${DB_ROLES.worker};
      REVOKE DELETE ON TABLE "creator", "creator_call_outcome" FROM ${DB_ROLES.worker};
      REVOKE DELETE ON TABLE "source_account", "source_ingest" FROM ${DB_ROLES.worker};
      GRANT SELECT, INSERT ON TABLE
        "tcg_market_snapshot", "tcg_market_quarantine", "tcg_market_revision",
        "tcg_market_feature_snapshot", "tcg_index_definition", "tcg_index_membership",
        "tcg_index_level", "creator_call_alpha", "tcg_score_snapshot",
      "tcg_prediction",
      "tcg_prediction_outcome",
      "tcg_backtest_run"
      TO ${DB_ROLES.worker};
      GRANT UPDATE ON TABLE "tcg_index_membership" TO ${DB_ROLES.worker};
      GRANT SELECT, INSERT, UPDATE ON TABLE "tcg_market_ingest" TO ${DB_ROLES.worker};
      REVOKE INSERT, UPDATE, DELETE ON TABLE
        "tcg_market_ingest", "tcg_market_snapshot", "tcg_market_quarantine", "tcg_market_revision",
        "tcg_market_feature_snapshot", "tcg_index_definition", "tcg_index_membership",
        "tcg_index_level", "creator_call_alpha", "tcg_score_snapshot",
      "tcg_prediction",
      "tcg_prediction_outcome",
      "tcg_backtest_run"
      FROM ${DB_ROLES.user};
      REVOKE UPDATE, DELETE ON TABLE
        "tcg_market_snapshot", "tcg_market_quarantine", "tcg_market_revision",
        "tcg_market_feature_snapshot", "tcg_index_definition", "tcg_index_level", "creator_call_alpha", "tcg_score_snapshot",
      "tcg_prediction",
      "tcg_prediction_outcome",
      "tcg_backtest_run"
      FROM ${DB_ROLES.worker};
      REVOKE DELETE ON TABLE "tcg_market_ingest", "tcg_index_membership" FROM ${DB_ROLES.worker};
      GRANT SELECT, INSERT ON TABLE "audit_event" TO ${DB_ROLES.user}, ${DB_ROLES.worker};
      REVOKE UPDATE, DELETE ON TABLE "audit_event" FROM ${DB_ROLES.user}, ${DB_ROLES.worker};
      GRANT SELECT ON TABLE
        "crm_operator_note", "crm_tag", "crm_organization_tag",
        "crm_segment_definition", "crm_segment_membership"
      TO ${DB_ROLES.user}, ${DB_ROLES.worker};
      REVOKE INSERT, UPDATE, DELETE ON TABLE
        "crm_operator_note", "crm_tag", "crm_organization_tag",
        "crm_segment_definition", "crm_segment_membership"
      FROM ${DB_ROLES.user}, ${DB_ROLES.worker};
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "tenant_content_report" TO ${DB_ROLES.user}, ${DB_ROLES.worker};
      GRANT SELECT, INSERT ON TABLE
        "content_candidate", "content_evidence_package", "content_draft",
        "content_claim", "content_validation", "content_publication"
      TO ${DB_ROLES.worker};
      REVOKE INSERT, UPDATE, DELETE ON TABLE
        "content_candidate", "content_evidence_package", "content_draft",
        "content_claim", "content_validation", "content_publication"
      FROM ${DB_ROLES.user};
      REVOKE UPDATE, DELETE ON TABLE
        "content_candidate", "content_evidence_package", "content_draft",
        "content_claim", "content_validation", "content_publication"
      FROM ${DB_ROLES.worker};
      GRANT SELECT ON TABLE "platform_admins" TO ${DB_ROLES.user}, ${DB_ROLES.worker};
      REVOKE INSERT, UPDATE, DELETE ON TABLE "platform_admins" FROM ${DB_ROLES.user}, ${DB_ROLES.worker};
      GRANT SELECT ON TABLE
        "platform_break_glass_audit", "platform_support_case"
      TO ${DB_ROLES.user}, ${DB_ROLES.worker};
      REVOKE INSERT, UPDATE, DELETE ON TABLE
        "platform_break_glass_audit", "platform_support_case"
      FROM ${DB_ROLES.user}, ${DB_ROLES.worker};
      GRANT SELECT ON TABLE "platform_feature_flags" TO ${DB_ROLES.user}, ${DB_ROLES.worker};
      REVOKE INSERT, UPDATE, DELETE ON TABLE "platform_feature_flags" FROM ${DB_ROLES.user}, ${DB_ROLES.worker};
      GRANT SELECT ON TABLE "beta_invitation" TO ${DB_ROLES.user}, ${DB_ROLES.worker};
      REVOKE INSERT, UPDATE, DELETE ON TABLE "beta_invitation" FROM ${DB_ROLES.user}, ${DB_ROLES.worker};
      GRANT SELECT ON TABLE
        "provider_runtime", "provider_sync_run",
        "source_sentiment", "intelligence_quarantine",
        "tcg_market_quarantine_review", "worker_heartbeat"
      TO ${DB_ROLES.user}, ${DB_ROLES.worker};
      GRANT SELECT ON TABLE "platform_outbox" TO ${DB_ROLES.worker};
      GRANT SELECT, INSERT, UPDATE ON TABLE
        "provider_runtime", "provider_sync_run", "platform_outbox",
        "intelligence_quarantine", "worker_heartbeat"
      TO ${DB_ROLES.worker};
      GRANT SELECT, INSERT ON TABLE
        "source_sentiment", "tcg_market_quarantine_review"
      TO ${DB_ROLES.worker};
      REVOKE INSERT, UPDATE, DELETE ON TABLE
        "provider_runtime", "provider_sync_run", "platform_outbox",
        "source_sentiment", "intelligence_quarantine",
        "tcg_market_quarantine_review", "worker_heartbeat"
      FROM ${DB_ROLES.user};
      REVOKE SELECT ON TABLE "platform_outbox" FROM ${DB_ROLES.user};
      REVOKE DELETE ON TABLE
        "provider_runtime", "provider_sync_run", "platform_outbox",
        "source_sentiment", "intelligence_quarantine",
        "tcg_market_quarantine_review", "worker_heartbeat"
      FROM ${DB_ROLES.worker};
      REVOKE UPDATE ON TABLE "source_sentiment", "tcg_market_quarantine_review" FROM ${DB_ROLES.worker};
      GRANT SELECT, INSERT, UPDATE ON TABLE "beta_organization", "product_feedback", "bug_report" TO ${DB_ROLES.user}, ${DB_ROLES.worker};
      GRANT SELECT, INSERT ON TABLE "product_event" TO ${DB_ROLES.user}, ${DB_ROLES.worker};
      REVOKE UPDATE, DELETE ON TABLE "product_event" FROM ${DB_ROLES.user}, ${DB_ROLES.worker};
      GRANT DELETE ON TABLE "alert_rule", "webhook_endpoint", "webhook_delivery" TO ${DB_ROLES.user}, ${DB_ROLES.worker};
      REVOKE DELETE ON TABLE
        "crm_organization_profile", "crm_user_profile", "crm_lifecycle_transition",
        "crm_customer_event", "crm_churn_reason", "notification_preference",
        "email_delivery", "in_app_notification", "usage_warning"
      FROM ${DB_ROLES.user}, ${DB_ROLES.worker};
      REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE "stripe_event" FROM ${DB_ROLES.user}, ${DB_ROLES.worker};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${DB_ROLES.migrate}, ${DB_ROLES.admin};
      GRANT ALL ON ALL FUNCTIONS IN SCHEMA app TO ${DB_ROLES.migrate}, ${DB_ROLES.admin};
      GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO ${DB_ROLES.migrate}, ${DB_ROLES.admin};
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
      GRANT EXECUTE ON FUNCTION app.list_pending_outbox(integer) TO ${DB_ROLES.user}, ${DB_ROLES.worker};
      GRANT EXECUTE ON FUNCTION app.consume_beta_invite(text, text) TO ${DB_ROLES.user}, ${DB_ROLES.worker}, ${DB_ROLES.migrate}, ${DB_ROLES.admin};
      REVOKE EXECUTE ON FUNCTION app.list_pending_platform_outbox(integer) FROM ${DB_ROLES.user};
      GRANT EXECUTE ON FUNCTION app.list_pending_platform_outbox(integer) TO ${DB_ROLES.worker};
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
