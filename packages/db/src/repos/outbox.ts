import { and, eq, sql } from "drizzle-orm";
import { assertTenantContext } from "../rls.js";
import { outboxJob } from "../schema/ingest.js";
import type { Database } from "../client.js";

export async function insertOutboxJob(
  scoped: Database,
  input: {
    id: string;
    organizationId: string;
    sourceEventId: string;
    jobType: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await assertTenantContext(scoped);
  await scoped.insert(outboxJob).values({
    id: input.id,
    organizationId: input.organizationId,
    sourceEventId: input.sourceEventId,
    jobType: input.jobType,
    payload: input.payload,
    status: "pending",
  });
}

export async function getOutboxJob(
  scoped: Database,
  input: { organizationId: string; id: string },
) {
  await assertTenantContext(scoped);
  const [row] = await scoped
    .select()
    .from(outboxJob)
    .where(and(eq(outboxJob.organizationId, input.organizationId), eq(outboxJob.id, input.id)))
    .limit(1);
  return row ?? null;
}

export async function listOutboxJobs(
  scoped: Database,
  organizationId: string,
) {
  await assertTenantContext(scoped);
  return scoped
    .select({
      id: outboxJob.id,
      organizationId: outboxJob.organizationId,
      sourceEventId: outboxJob.sourceEventId,
      status: outboxJob.status,
    })
    .from(outboxJob)
    .where(eq(outboxJob.organizationId, organizationId));
}

export async function markOutboxPublished(
  scoped: Database,
  input: { organizationId: string; id: string },
): Promise<number> {
  await assertTenantContext(scoped);
  const updated = await scoped
    .update(outboxJob)
    .set({
      status: "published",
      publishedAt: new Date(),
      lastError: null,
    })
    .where(and(eq(outboxJob.id, input.id), eq(outboxJob.organizationId, input.organizationId)))
    .returning({ id: outboxJob.id });
  return updated.length;
}

export async function markOutboxPublishFailed(
  scoped: Database,
  input: { organizationId: string; id: string; error: string },
): Promise<void> {
  await assertTenantContext(scoped);
  await scoped
    .update(outboxJob)
    .set({
      attempts: sql`${outboxJob.attempts} + 1`,
      lastError: input.error.slice(0, 300),
      availableAt: new Date(Date.now() + 5_000),
    })
    .where(and(eq(outboxJob.id, input.id), eq(outboxJob.organizationId, input.organizationId)));
}

export async function listPendingOutboxRefs(
  db: Database,
  limit = 20,
): Promise<{ id: string; organizationId: string }[]> {
  const result = await db.execute(sql`
    select id, organization_id from app.list_pending_outbox(${limit})
  `);
  const rows = Array.isArray(result)
    ? result
    : "rows" in (result as object)
      ? (result as { rows: unknown[] }).rows
      : [];
  return (rows as { id?: string; organization_id?: string }[])
    .filter((row) => row.id && row.organization_id)
    .map((row) => ({ id: String(row.id), organizationId: String(row.organization_id) }));
}
