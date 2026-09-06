import { desc, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { emailDelivery } from "../schema/notification.js";
import type { EmailDeliveryStatus } from "./catalog.js";

export async function insertEmailDelivery(
  db: Database,
  input: {
    organizationId?: string | null;
    userId?: string | null;
    templateKey: string;
    templateVersion: string;
    provider: string;
    status: EmailDeliveryStatus;
    attempt?: number;
    failureCategory?: string | null;
    sentAt?: Date | null;
  },
) {
  const [row] = await db
    .insert(emailDelivery)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId ?? null,
      userId: input.userId ?? null,
      templateKey: input.templateKey,
      templateVersion: input.templateVersion,
      provider: input.provider,
      status: input.status,
      attempt: input.attempt ?? 1,
      failureCategory: input.failureCategory ?? null,
      sentAt: input.sentAt ?? (input.status === "sent" ? new Date() : null),
    })
    .returning();
  return row!;
}

export type QueuedEmailSend = (input: {
  id: string;
  templateKey: string;
  userId: string | null;
}) => Promise<void>;

export async function processQueuedEmailDeliveries(
  db: Database,
  input?: { send?: QueuedEmailSend; limit?: number },
) {
  const limit = Math.min(Math.max(input?.limit ?? 10, 1), 25);
  const rows = await db
    .select()
    .from(emailDelivery)
    .where(eq(emailDelivery.status, "queued"))
    .orderBy(emailDelivery.createdAt)
    .limit(limit);
  if (!input?.send) {
    return { processed: 0, failed: 0, skipped: rows.length, reason: "send_not_configured" as const };
  }
  let processed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await input.send({ id: row.id, templateKey: row.templateKey, userId: row.userId });
      await db
        .update(emailDelivery)
        .set({ status: "sent", sentAt: new Date(), failureCategory: null })
        .where(eq(emailDelivery.id, row.id));
      processed += 1;
    } catch {
      await db
        .update(emailDelivery)
        .set({
          status: "failed",
          attempt: row.attempt + 1,
          failureCategory: "provider",
        })
        .where(eq(emailDelivery.id, row.id));
      failed += 1;
    }
  }
  return { processed, failed, skipped: 0, reason: null };
}

export async function listEmailDeliveries(db: Database, organizationId: string) {
  return db
    .select({
      id: emailDelivery.id,
      organizationId: emailDelivery.organizationId,
      userId: emailDelivery.userId,
      templateKey: emailDelivery.templateKey,
      templateVersion: emailDelivery.templateVersion,
      provider: emailDelivery.provider,
      status: emailDelivery.status,
      attempt: emailDelivery.attempt,
      failureCategory: emailDelivery.failureCategory,
      createdAt: emailDelivery.createdAt,
      sentAt: emailDelivery.sentAt,
    })
    .from(emailDelivery)
    .where(eq(emailDelivery.organizationId, organizationId))
    .orderBy(desc(emailDelivery.createdAt));
}
