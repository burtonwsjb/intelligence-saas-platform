import { eq } from "drizzle-orm";
import {
  ensureCrmOrganization,
  ensureTenantBilling,
  tenant,
  withOrganizationContext,
  type Database,
} from "@isp/db";

export async function ensureTenantRow(
  db: Database,
  input: { organizationId: string; createdByUserId: string; displayName?: string },
): Promise<void> {
  await withOrganizationContext(
    db,
    {
      organizationId: input.organizationId,
      userId: input.createdByUserId,
    },
    async (scoped) => {
      const existing = await scoped
        .select({ organizationId: tenant.organizationId })
        .from(tenant)
        .where(eq(tenant.organizationId, input.organizationId))
        .limit(1);
      if (!existing[0]) {
        await scoped.insert(tenant).values({
          organizationId: input.organizationId,
          status: "active",
          createdByUserId: input.createdByUserId,
        });
      }
      await ensureTenantBilling(scoped, input.organizationId);
      await ensureCrmOrganization(scoped, {
        organizationId: input.organizationId,
        userId: input.createdByUserId,
        displayName: input.displayName ?? input.organizationId,
        signupSource: "self_serve",
      });
    },
  );
}
