import { sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { withSystemContext } from "../rls.js";
import { upsertTenantEntitlementOverride } from "../repos/billing.js";
import { insertAuditEvent } from "../repos/audit.js";

/**
 * Operator view of customer API access for the admin console. Runs on the
 * platform admin connection (app_admin, BYPASSRLS), so it can read every
 * workspace's keys and usage. Never returns secret hashes.
 */

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []);
}

export type OperatorApiKeyRow = {
  id: string;
  organizationId: string;
  organizationName: string;
  name: string;
  prefix: string;
  scopes: string[];
  status: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  requestsThisMonth: number;
  /** Lifetime requests with this key, counted since migration 0047. */
  requestCount: number;
  rateLimitPerMinute: number | null;
  note: string | null;
  issuedByOperator: boolean;
};

export async function listOperatorApiKeys(adminDb: Database): Promise<OperatorApiKeyRow[]> {
  const result = await adminDb.execute(sql`
    select k.id, k.organization_id, o.name as organization_name, k.name, k.prefix, k.scopes,
           k.status, k.created_at, k.last_used_at, k.expires_at, k.revoked_at,
           k.request_count, k.rate_limit_per_minute, k.note, k.issued_by_operator,
           coalesce(u.requests, 0)::bigint as requests
    from api_key k
    join organization o on o.id = k.organization_id
    left join lateral (
      select sum(e.quantity) as requests
      from usage_event e
      where e.api_key_id = k.id
        and e.meter_key = 'api.reads'
        and e.occurred_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'
    ) u on true
    order by (k.status = 'active') desc, k.created_at desc
    limit 500
  `);
  return rowsOf<Record<string, unknown>>(result).map((row) => ({
    id: String(row.id),
    organizationId: String(row.organization_id),
    organizationName: String(row.organization_name ?? row.organization_id),
    name: String(row.name),
    prefix: String(row.prefix),
    scopes: String(row.scopes ?? "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
    status: String(row.status),
    createdAt: new Date(String(row.created_at)),
    lastUsedAt: row.last_used_at ? new Date(String(row.last_used_at)) : null,
    expiresAt: row.expires_at ? new Date(String(row.expires_at)) : null,
    revokedAt: row.revoked_at ? new Date(String(row.revoked_at)) : null,
    requestsThisMonth: Number(row.requests ?? 0),
    requestCount: Number(row.request_count ?? 0),
    rateLimitPerMinute:
      row.rate_limit_per_minute === null || row.rate_limit_per_minute === undefined ? null : Number(row.rate_limit_per_minute),
    note: row.note ? String(row.note) : null,
    issuedByOperator: row.issued_by_operator === true || row.issued_by_operator === "t",
  }));
}

export type OperatorApiWorkspaceRow = {
  organizationId: string;
  name: string;
  ownerEmail: string | null;
  planKey: string;
  billingStatus: string;
  activeKeys: number;
  requestsThisMonth: number;
  requestLimitOverride: number | null;
};

export async function listApiAccessWorkspaces(adminDb: Database): Promise<OperatorApiWorkspaceRow[]> {
  const result = await adminDb.execute(sql`
    select o.id, o.name,
           (select u.email from member m join "user" u on u.id = m.user_id
             where m.organization_id = o.id order by (m.role = 'owner') desc, m.created_at asc limit 1) as owner_email,
           coalesce(b.plan_key, 'free') as plan_key,
           coalesce(b.status, 'none') as billing_status,
           (select count(*) from api_key k where k.organization_id = o.id and k.status = 'active') as active_keys,
           coalesce((select um.quantity from usage_month um
             where um.organization_id = o.id and um.meter_key = 'api.reads'
               and um.period_start = date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'), 0) as requests,
           (select ov.limit_value from tenant_entitlement_override ov
             where ov.organization_id = o.id and ov.entitlement_key = 'api_requests_per_month' and ov.enabled) as limit_override
    from organization o
    left join tenant_billing b on b.organization_id = o.id
    order by o.created_at desc
    limit 500
  `);
  return rowsOf<Record<string, unknown>>(result).map((row) => ({
    organizationId: String(row.id),
    name: String(row.name ?? row.id),
    ownerEmail: row.owner_email ? String(row.owner_email) : null,
    planKey: String(row.plan_key),
    billingStatus: String(row.billing_status),
    activeKeys: Number(row.active_keys ?? 0),
    requestsThisMonth: Number(row.requests ?? 0),
    requestLimitOverride:
      row.limit_override === null || row.limit_override === undefined ? null : Number(row.limit_override),
  }));
}

export class ApiRequestLimitError extends Error {
  constructor() {
    super("API request limit must be a whole number from 0 to 100,000,000.");
    this.name = "ApiRequestLimitError";
  }
}

/**
 * Give one workspace its own monthly API request allowance, replacing what its
 * plan allows. `null` removes the override so the plan's limit applies again.
 */
export async function setWorkspaceApiRequestLimit(
  adminDb: Database,
  input: { organizationId: string; actorUserId: string; limit: number | null },
): Promise<void> {
  if (input.limit !== null && (!Number.isInteger(input.limit) || input.limit < 0 || input.limit > 100_000_000)) {
    throw new ApiRequestLimitError();
  }
  await withSystemContext(adminDb, { organizationId: input.organizationId }, async (scoped) => {
    if (input.limit === null) {
      await scoped.execute(sql`
        delete from tenant_entitlement_override
        where organization_id = ${input.organizationId} and entitlement_key = 'api_requests_per_month'
      `);
    } else {
      await upsertTenantEntitlementOverride(scoped, {
        organizationId: input.organizationId,
        entitlementKey: "api_requests_per_month",
        valueKind: "limit",
        enabled: true,
        limitValue: input.limit,
      });
    }
    await insertAuditEvent(scoped, {
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: "entitlement.override",
      targetType: "entitlement",
      targetId: "api_requests_per_month",
      metadata: { limit: input.limit, setBy: "platform_operator" },
    });
  });
}
