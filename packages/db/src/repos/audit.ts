import { and, desc, eq } from "drizzle-orm";
import { auditEvent } from "../schema/audit.js";
import { assertTenantContext } from "../rls.js";
import type { Database } from "../client.js";

export async function insertAuditEvent(
  scoped: Database,
  input: {
    id: string;
    organizationId: string;
    actorUserId?: string | null;
    action: string;
    targetType?: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await assertTenantContext(scoped);
  await scoped.insert(auditEvent).values({
    id: input.id,
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    metadata: input.metadata,
  });
}

export async function listAuditEvents(
  scoped: Database,
  organizationId: string,
): Promise<(typeof auditEvent.$inferSelect)[]> {
  await assertTenantContext(scoped);
  return scoped
    .select()
    .from(auditEvent)
    .where(and(eq(auditEvent.organizationId, organizationId)));
}

export async function getLatestAuditEvent(
  scoped: Database,
  input: { organizationId: string; action: string },
) {
  await assertTenantContext(scoped);
  const [row] = await scoped
    .select()
    .from(auditEvent)
    .where(and(eq(auditEvent.organizationId, input.organizationId), eq(auditEvent.action, input.action)))
    .orderBy(desc(auditEvent.createdAt))
    .limit(1);
  return row ?? null;
}
