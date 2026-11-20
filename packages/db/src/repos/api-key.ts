import { and, eq, sql } from "drizzle-orm";
import { assertTenantContext } from "../rls.js";
import { apiKey } from "../schema/api-key.js";
import type { Database } from "../client.js";

export type ApiKeyLookup = {
  id: string;
  organizationId: string;
  secretHash: string;
  scopes: string;
  status: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
};

export async function lookupApiKeyByPrefix(
  db: Database,
  prefix: string,
): Promise<ApiKeyLookup | null> {
  const result = await db.execute(sql`
    select id, organization_id, secret_hash, scopes, status, expires_at, revoked_at
    from app.lookup_api_key_by_prefix(${prefix})
  `);
  const row = Array.isArray(result)
    ? (result[0] as Record<string, unknown> | undefined)
    : "rows" in (result as object)
      ? (result as { rows: Record<string, unknown>[] }).rows[0]
      : undefined;
  if (!row?.id || !row.organization_id || !row.secret_hash) {
    return null;
  }
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    secretHash: String(row.secret_hash),
    scopes: String(row.scopes ?? ""),
    status: String(row.status ?? "revoked"),
    expiresAt: row.expires_at ? new Date(String(row.expires_at)) : null,
    revokedAt: row.revoked_at ? new Date(String(row.revoked_at)) : null,
  };
}

export async function insertApiKey(
  scoped: Database,
  input: {
    id: string;
    organizationId: string;
    name: string;
    prefix: string;
    secretHash: string;
    scopes: string;
    createdByUserId: string;
    expiresAt?: Date | null;
  },
): Promise<void> {
  await assertTenantContext(scoped);
  await scoped.insert(apiKey).values({
    id: input.id,
    organizationId: input.organizationId,
    name: input.name,
    prefix: input.prefix,
    secretHash: input.secretHash,
    scopes: input.scopes,
    status: "active",
    environment: "test",
    createdByUserId: input.createdByUserId,
    expiresAt: input.expiresAt,
  });
  const { recordCustomerEvent } = await import("../crm/events.js");
  await recordCustomerEvent(scoped, {
    organizationId: input.organizationId,
    userId: input.createdByUserId,
    eventType: "api_key.created",
  });
}

export async function listApiKeys(
  scoped: Database,
  organizationId: string,
) {
  await assertTenantContext(scoped);
  return scoped
    .select({
      id: apiKey.id,
      organizationId: apiKey.organizationId,
      name: apiKey.name,
      prefix: apiKey.prefix,
      scopes: apiKey.scopes,
      status: apiKey.status,
      createdAt: apiKey.createdAt,
      lastUsedAt: apiKey.lastUsedAt,
      expiresAt: apiKey.expiresAt,
      revokedAt: apiKey.revokedAt,
      rateLimitPerMinute: apiKey.rateLimitPerMinute,
      requestCount: apiKey.requestCount,
    })
    .from(apiKey)
    .where(eq(apiKey.organizationId, organizationId));
}

export async function countActiveApiKeys(
  scoped: Database,
  organizationId: string,
): Promise<number> {
  await assertTenantContext(scoped);
  const rows = await scoped
    .select({ id: apiKey.id })
    .from(apiKey)
    .where(and(eq(apiKey.organizationId, organizationId), eq(apiKey.status, "active")));
  return rows.length;
}

export async function revokeApiKey(
  scoped: Database,
  input: { id: string; organizationId: string },
): Promise<number> {
  await assertTenantContext(scoped);
  const updated = await scoped
    .update(apiKey)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(and(eq(apiKey.id, input.id), eq(apiKey.organizationId, input.organizationId)))
    .returning({ id: apiKey.id });
  return updated.length;
}

/**
 * Marks the key used and counts the request in one UPDATE, returning the
 * key's per-minute limit (null = no per-key limit) for the rate limiter.
 */
export async function touchApiKeyLastUsed(
  scoped: Database,
  input: { id: string; organizationId: string },
): Promise<{ rateLimitPerMinute: number | null }> {
  await assertTenantContext(scoped);
  const [row] = await scoped
    .update(apiKey)
    .set({ lastUsedAt: new Date(), requestCount: sql`${apiKey.requestCount} + 1` })
    .where(and(eq(apiKey.id, input.id), eq(apiKey.organizationId, input.organizationId)))
    .returning({ rateLimitPerMinute: apiKey.rateLimitPerMinute });
  return { rateLimitPerMinute: row?.rateLimitPerMinute ?? null };
}

/** Per-key settings an operator changes from /admin/api-keys (migration 0047). */
export async function updateApiKeySettings(
  scoped: Database,
  input: {
    id: string;
    organizationId: string;
    rateLimitPerMinute?: number | null;
    note?: string | null;
    issuedByOperator?: boolean;
  },
): Promise<number> {
  await assertTenantContext(scoped);
  const set: Partial<typeof apiKey.$inferInsert> = {};
  if (input.rateLimitPerMinute !== undefined) set.rateLimitPerMinute = input.rateLimitPerMinute;
  if (input.note !== undefined) set.note = input.note;
  if (input.issuedByOperator !== undefined) set.issuedByOperator = input.issuedByOperator;
  if (Object.keys(set).length === 0) return 0;
  const updated = await scoped
    .update(apiKey)
    .set(set)
    .where(and(eq(apiKey.id, input.id), eq(apiKey.organizationId, input.organizationId)))
    .returning({ id: apiKey.id });
  return updated.length;
}

/** One key's settings for rotation; never returns the secret hash. */
export async function getApiKeySettings(scoped: Database, input: { id: string; organizationId: string }) {
  await assertTenantContext(scoped);
  const [row] = await scoped
    .select({
      id: apiKey.id,
      name: apiKey.name,
      scopes: apiKey.scopes,
      status: apiKey.status,
      expiresAt: apiKey.expiresAt,
      rateLimitPerMinute: apiKey.rateLimitPerMinute,
      note: apiKey.note,
    })
    .from(apiKey)
    .where(and(eq(apiKey.id, input.id), eq(apiKey.organizationId, input.organizationId)))
    .limit(1);
  return row ?? null;
}
