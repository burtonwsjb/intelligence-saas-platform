import { and, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { crmUserProfile } from "../schema/crm.js";
import { assertTenantContext } from "../rls.js";

export async function upsertCrmUserProfile(
  scoped: Database,
  input: {
    organizationId: string;
    userId: string;
    displayName?: string | null;
    jobTitle?: string | null;
    timezone?: string | null;
    productRole?: string | null;
  },
) {
  await assertTenantContext(scoped);
  await scoped
    .insert(crmUserProfile)
    .values({
      organizationId: input.organizationId,
      userId: input.userId,
      displayName: input.displayName?.slice(0, 80) ?? null,
      jobTitle: input.jobTitle?.slice(0, 80) ?? null,
      timezone: input.timezone?.slice(0, 64) ?? null,
      productRole: input.productRole?.slice(0, 40) ?? null,
    })
    .onConflictDoUpdate({
      target: [crmUserProfile.organizationId, crmUserProfile.userId],
      set: {
        displayName: input.displayName?.slice(0, 80) ?? null,
        jobTitle: input.jobTitle?.slice(0, 80) ?? null,
        timezone: input.timezone?.slice(0, 64) ?? null,
        productRole: input.productRole?.slice(0, 40) ?? null,
        updatedAt: new Date(),
      },
    });
}

export async function getCrmUserProfile(
  scoped: Database,
  input: { organizationId: string; userId: string },
) {
  await assertTenantContext(scoped);
  const [row] = await scoped
    .select()
    .from(crmUserProfile)
    .where(
      and(
        eq(crmUserProfile.organizationId, input.organizationId),
        eq(crmUserProfile.userId, input.userId),
      ),
    )
    .limit(1);
  return row ?? null;
}
