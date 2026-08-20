import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { crmOrganizationProfile, crmOrganizationTag } from "../schema/crm.js";
import type { LifecycleStage } from "./catalog.js";

/**
 * Platform-admin CRM listings. Run as `app_admin` (BYPASSRLS) to see all
 * tenants. `app_user` is limited to the active organization by RLS.
 */
export async function listCrmCustomers(
  db: Database,
  input?: { stages?: LifecycleStage[]; limit?: number },
) {
  const query = db.select().from(crmOrganizationProfile);
  if (input?.stages && input.stages.length > 0) {
    return query
      .where(inArray(crmOrganizationProfile.lifecycleStage, input.stages))
      .limit(Math.min(input.limit ?? 200, 500));
  }
  return query.limit(Math.min(input?.limit ?? 200, 500));
}

export async function listTrialCustomers(db: Database) {
  return listCrmCustomers(db, { stages: ["trial"] });
}

export async function listActiveCustomers(db: Database) {
  return listCrmCustomers(db, { stages: ["customer", "activated"] });
}

export async function listPastDueCustomers(db: Database) {
  return listCrmCustomers(db, { stages: ["past_due"] });
}

export async function listCanceledCustomers(db: Database) {
  return listCrmCustomers(db, { stages: ["canceled", "churned"] });
}

export async function listAtRiskCustomers(db: Database) {
  return listCrmCustomers(db, { stages: ["at_risk"] });
}

export async function listRecentSignups(db: Database, since: Date) {
  return db
    .select()
    .from(crmOrganizationProfile)
    .where(gte(crmOrganizationProfile.createdAt, since));
}

export async function listInactiveCustomers(db: Database, before: Date) {
  return db
    .select()
    .from(crmOrganizationProfile)
    .where(
      and(
        lte(crmOrganizationProfile.lastActivityAt, before),
      ),
    );
}

export async function listCustomersMissingActivity(db: Database) {
  return db
    .select()
    .from(crmOrganizationProfile)
    .where(isNull(crmOrganizationProfile.lastActivityAt));
}

export async function listCustomersByTag(db: Database, tagKey: string) {
  return db
    .select({
      organizationId: crmOrganizationProfile.organizationId,
      displayName: crmOrganizationProfile.displayName,
      lifecycleStage: crmOrganizationProfile.lifecycleStage,
      tagKey: crmOrganizationTag.tagKey,
    })
    .from(crmOrganizationTag)
    .innerJoin(
      crmOrganizationProfile,
      eq(crmOrganizationProfile.organizationId, crmOrganizationTag.organizationId),
    )
    .where(eq(crmOrganizationTag.tagKey, tagKey));
}

export async function listHighUsageCandidates(db: Database) {
  return listCustomersByTag(db, "high_usage");
}

export async function countCustomersByStage(db: Database) {
  return db
    .select({
      lifecycleStage: crmOrganizationProfile.lifecycleStage,
      count: sql<number>`count(*)::int`,
    })
    .from(crmOrganizationProfile)
    .groupBy(crmOrganizationProfile.lifecycleStage);
}
