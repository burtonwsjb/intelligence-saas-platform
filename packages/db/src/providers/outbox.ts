import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { platformOutbox } from "../schema/provider.js";
import { MAX_OUTBOX_PUBLISH_ATTEMPTS } from "../platform/recovery.js";

export const PLATFORM_JOB_VERSION = 1;

export function platformJobCreatedAt(): string {
  return new Date().toISOString();
}

export async function enqueuePlatformJob(
  db: Database,
  input: {
    id: string;
    jobType: string;
    payload: Record<string, unknown>;
    availableAt?: Date;
  },
): Promise<{ enqueued: boolean }> {
  const inserted = await db
    .insert(platformOutbox)
    .values({
      id: input.id,
      jobType: input.jobType,
      payload: input.payload,
      status: "pending",
      availableAt: input.availableAt ?? new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: platformOutbox.id });
  return { enqueued: inserted.length > 0 };
}

export async function listPendingPlatformOutbox(db: Database, limit = 20) {
  try {
    const result = await db.execute(sql`
      select id, job_type from app.list_pending_platform_outbox(${limit})
    `);
    const rows = Array.isArray(result)
      ? result
      : "rows" in (result as object)
        ? (result as { rows: unknown[] }).rows
        : [];
    const mapped = (rows as { id?: string; job_type?: string }[])
      .filter((row) => row.id && row.job_type)
      .map((row) => ({ id: String(row.id), jobType: String(row.job_type) }));
    if (mapped.length > 0) {
      return mapped;
    }
  } catch {
    // PGlite or missing function: fall through to table scan.
  }
  const rows = await db
    .select({ id: platformOutbox.id, jobType: platformOutbox.jobType })
    .from(platformOutbox)
    .where(eq(platformOutbox.status, "pending"))
    .limit(Math.min(limit, 100));
  return rows;
}

export async function getPlatformOutbox(db: Database, id: string) {
  const [row] = await db.select().from(platformOutbox).where(eq(platformOutbox.id, id)).limit(1);
  return row ?? null;
}

export async function markPlatformOutboxPublished(db: Database, id: string): Promise<number> {
  const updated = await db
    .update(platformOutbox)
    .set({ status: "published", publishedAt: new Date(), lastError: null })
    .where(and(eq(platformOutbox.id, id), eq(platformOutbox.status, "pending")))
    .returning({ id: platformOutbox.id });
  return updated.length;
}

export async function markPlatformOutboxPublishFailed(db: Database, id: string, error: string): Promise<void> {
  await db
    .update(platformOutbox)
    .set({
      attempts: sql`${platformOutbox.attempts} + 1`,
      lastError: error.slice(0, 300),
      availableAt: sql`CASE WHEN ${platformOutbox.attempts} + 1 >= ${MAX_OUTBOX_PUBLISH_ATTEMPTS} THEN ${platformOutbox.availableAt} ELSE now() + interval '5 seconds' END`,
      status: sql`CASE WHEN ${platformOutbox.attempts} + 1 >= ${MAX_OUTBOX_PUBLISH_ATTEMPTS} THEN 'failed' ELSE ${platformOutbox.status} END`,
      failedAt: sql`CASE WHEN ${platformOutbox.attempts} + 1 >= ${MAX_OUTBOX_PUBLISH_ATTEMPTS} THEN now() ELSE ${platformOutbox.failedAt} END`,
    })
    .where(eq(platformOutbox.id, id));
}

export async function markPlatformOutboxProcessed(db: Database, id: string): Promise<void> {
  await db
    .update(platformOutbox)
    .set({ status: "processed", completedAt: new Date() })
    .where(eq(platformOutbox.id, id));
}

export async function markPlatformOutboxFailed(
  db: Database, id: string, error: string, options?: { onlyIfPublished?: boolean },
): Promise<number> {
  const updated = await db
    .update(platformOutbox)
    .set({ status: "failed", failedAt: new Date(), lastError: error.slice(0, 300) })
    .where(options?.onlyIfPublished
      ? and(eq(platformOutbox.id, id), eq(platformOutbox.status, "published"))
      : eq(platformOutbox.id, id))
    .returning({ id: platformOutbox.id });
  return updated.length;
}

export async function retryFailedPlatformJob(db: Database, id: string): Promise<boolean> {
  const updated = await db
    .update(platformOutbox)
    .set({
      status: "pending",
      availableAt: new Date(),
      lastError: null,
      failedAt: null,
    })
    .where(and(eq(platformOutbox.id, id), eq(platformOutbox.status, "failed")))
    .returning({ id: platformOutbox.id });
  return updated.length > 0;
}
