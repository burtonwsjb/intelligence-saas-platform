import { eq } from "drizzle-orm";
import { tenant, withOrganizationContext, type Database } from "@isp/db";

export async function ensureTenantRow(
  db: Database,
  input: { organizationId: string; createdByUserId: string },
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
      if (existing[0]) {
        return;
      }
      await scoped.insert(tenant).values({
        organizationId: input.organizationId,
        status: "active",
        createdByUserId: input.createdByUserId,
      });
    },
  );
}
