import { and, eq } from "drizzle-orm";
import { tenantResource } from "../schema/resource.js";
import { assertTenantContext } from "../rls.js";
import type { Database } from "../client.js";

export async function insertTenantResource(
  scoped: Database,
  input: { id: string; organizationId: string; title: string; body?: string },
): Promise<void> {
  await assertTenantContext(scoped);
  await scoped.insert(tenantResource).values({
    id: input.id,
    organizationId: input.organizationId,
    title: input.title,
    body: input.body,
  });
}

export async function listTenantResources(
  scoped: Database,
  organizationId: string,
): Promise<(typeof tenantResource.$inferSelect)[]> {
  await assertTenantContext(scoped);
  return scoped
    .select()
    .from(tenantResource)
    .where(eq(tenantResource.organizationId, organizationId));
}

export async function updateTenantResource(
  scoped: Database,
  input: { id: string; organizationId: string; title: string },
): Promise<number> {
  await assertTenantContext(scoped);
  const updated = await scoped
    .update(tenantResource)
    .set({ title: input.title, updatedAt: new Date() })
    .where(
      and(
        eq(tenantResource.id, input.id),
        eq(tenantResource.organizationId, input.organizationId),
      ),
    )
    .returning({ id: tenantResource.id });
  return updated.length;
}

export async function deleteTenantResource(
  scoped: Database,
  input: { id: string; organizationId: string },
): Promise<number> {
  await assertTenantContext(scoped);
  const removed = await scoped
    .delete(tenantResource)
    .where(
      and(
        eq(tenantResource.id, input.id),
        eq(tenantResource.organizationId, input.organizationId),
      ),
    )
    .returning({ id: tenantResource.id });
  return removed.length;
}
