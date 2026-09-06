import { eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { apiKey } from "../schema/api-key.js";
import { member } from "../schema/organization.js";
import { tenant } from "../schema/tenant.js";
import { webhookEndpoint } from "../schema/webhook.js";

export type OrganizationExportPackage = {
  organization_id: string;
  exported_at: string;
  members: Array<{ user_id: string; role: string }>;
  api_keys: Array<{ id: string; name: string; prefix: string; status: string; scopes: string }>;
  webhooks: Array<{ id: string; url: string; status: string; event_types: string[] }>;
};

export async function exportOrganizationData(
  db: Database,
  organizationId: string,
): Promise<OrganizationExportPackage> {
  const [members, keys, hooks] = await Promise.all([
    db.select({ userId: member.userId, role: member.role }).from(member).where(eq(member.organizationId, organizationId)),
    db
      .select({
        id: apiKey.id,
        name: apiKey.name,
        prefix: apiKey.prefix,
        status: apiKey.status,
        scopes: apiKey.scopes,
      })
      .from(apiKey)
      .where(eq(apiKey.organizationId, organizationId)),
    db
      .select({
        id: webhookEndpoint.id,
        url: webhookEndpoint.url,
        status: webhookEndpoint.status,
        eventTypes: webhookEndpoint.eventTypes,
      })
      .from(webhookEndpoint)
      .where(eq(webhookEndpoint.organizationId, organizationId)),
  ]);
  return {
    organization_id: organizationId,
    exported_at: new Date().toISOString(),
    members: members.map((row) => ({ user_id: row.userId, role: row.role })),
    api_keys: keys.map((row) => ({
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      status: row.status,
      scopes: row.scopes,
    })),
    webhooks: hooks.map((row) => ({
      id: row.id,
      url: row.url,
      status: row.status,
      event_types: row.eventTypes,
    })),
  };
}

export async function disableOrganizationAccount(db: Database, organizationId: string) {
  await db.update(tenant).set({ status: "disabled" }).where(eq(tenant.organizationId, organizationId));
  await db.update(apiKey).set({ status: "revoked", revokedAt: new Date() }).where(eq(apiKey.organizationId, organizationId));
  await db
    .update(webhookEndpoint)
    .set({ status: "disabled", disabledAt: new Date(), updatedAt: new Date() })
    .where(eq(webhookEndpoint.organizationId, organizationId));
  const [row] = await db.select().from(tenant).where(eq(tenant.organizationId, organizationId)).limit(1);
  return row ?? null;
}
