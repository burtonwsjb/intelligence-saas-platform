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
