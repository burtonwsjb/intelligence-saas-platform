import { eq } from "drizzle-orm";
import { assertTenantContext } from "../rls.js";
import { tenant } from "../schema/tenant.js";
import type { Database } from "../client.js";

export async function getTenant(
  scoped: Database,
  organizationId: string,
) {
  await assertTenantContext(scoped);
  const [row] = await scoped
    .select({
      organizationId: tenant.organizationId,
      status: tenant.status,
    })
    .from(tenant)
    .where(eq(tenant.organizationId, organizationId))
    .limit(1);
  return row ?? null;
}
