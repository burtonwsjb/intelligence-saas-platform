import { desc, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { withSystemContext } from "../rls.js";
import { crmCustomerEvent, crmOrganizationProfile } from "../schema/crm.js";
import { tenantBilling } from "../schema/billing.js";
import { evaluateCustomerHealth } from "../crm/health.js";
import { listOperatorNotes } from "../crm/notes.js";
import { listOrganizationTags } from "../crm/tags.js";
import { listChurnReasons } from "../crm/churn.js";
import { insertBreakGlassAudit } from "./audit.js";

export class TenantInspectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantInspectError";
  }
}

/**
 * Audited break-glass tenant inspection. Uses the system principal plus
 * `app_admin` BYPASSRLS. Does not impersonate a tenant user session.
 */
export async function inspectTenant(
  db: Database,
  input: { organizationId: string; actorUserId: string },
) {
  await insertBreakGlassAudit(db, {
    actorUserId: input.actorUserId,
    action: "tenant.inspect",
    organizationId: input.organizationId,
    targetType: "organization",
    targetId: input.organizationId,
  });
  return withSystemContext(db, { organizationId: input.organizationId }, async (scoped) => {
    const [profile] = await scoped
      .select()
      .from(crmOrganizationProfile)
      .where(eq(crmOrganizationProfile.organizationId, input.organizationId))
      .limit(1);
    const [billing] = await scoped
      .select({
        organizationId: tenantBilling.organizationId,
        planKey: tenantBilling.planKey,
        status: tenantBilling.status,
        trialStartedAt: tenantBilling.trialStartedAt,
        trialEndsAt: tenantBilling.trialEndsAt,
        canceledAt: tenantBilling.canceledAt,
        pastDueSince: tenantBilling.pastDueSince,
        graceEndsAt: tenantBilling.graceEndsAt,
      })
      .from(tenantBilling)
      .where(eq(tenantBilling.organizationId, input.organizationId))
      .limit(1);
    const events = await scoped
      .select()
      .from(crmCustomerEvent)
      .where(eq(crmCustomerEvent.organizationId, input.organizationId))
      .orderBy(desc(crmCustomerEvent.createdAt))
      .limit(50);
    const notes = await listOperatorNotes(scoped, input.organizationId);
    const tags = await listOrganizationTags(scoped, input.organizationId);
    const churn = await listChurnReasons(scoped, input.organizationId);
    const health = profile
      ? await evaluateCustomerHealth(scoped, {
          organizationId: input.organizationId,
          billingStatus: billing?.status ?? "none",
        })
      : null;
    return {
      profile: profile ?? null,
      billing: billing ?? null,
      events,
      notes,
      tags,
      churn,
      health,
    };
  });
}
