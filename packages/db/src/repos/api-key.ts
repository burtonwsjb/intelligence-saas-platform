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

export async function touchApiKeyLastUsed(
  scoped: Database,
  input: { id: string; organizationId: string },
): Promise<void> {
  await assertTenantContext(scoped);
  await scoped
    .update(apiKey)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(apiKey.id, input.id), eq(apiKey.organizationId, input.organizationId)));
}
