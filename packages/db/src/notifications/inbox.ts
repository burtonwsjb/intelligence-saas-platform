import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { assertTenantContext } from "../rls.js";
import { inAppNotification } from "../schema/notification.js";
import { IN_APP_BODY_MAX_CHARS, type NotificationSeverity } from "./catalog.js";

export async function createInAppNotification(
  scoped: Database,
  input: {
    organizationId: string;
    userId?: string | null;
    type: string;
    title: string;
    body: string;
    severity?: NotificationSeverity;
    referenceType?: string | null;
    referenceId?: string | null;
    expiresAt?: Date | null;
  },
) {
  await assertTenantContext(scoped);
  const [row] = await scoped
    .insert(inAppNotification)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      userId: input.userId ?? null,
      type: input.type.slice(0, 80),
      title: input.title.slice(0, 120),
      body: input.body.slice(0, IN_APP_BODY_MAX_CHARS),
      severity: input.severity ?? "info",
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      expiresAt: input.expiresAt ?? null,
    })
    .returning();
  return row!;
}

export async function listInAppNotifications(
  scoped: Database,
  input: { organizationId: string; userId: string; unreadOnly?: boolean; limit?: number },
) {
  await assertTenantContext(scoped);
  const visibility = or(
    isNull(inAppNotification.userId),
    eq(inAppNotification.userId, input.userId),
  )!;
  const filters = input.unreadOnly
    ? and(eq(inAppNotification.organizationId, input.organizationId), visibility, isNull(inAppNotification.readAt))
    : and(eq(inAppNotification.organizationId, input.organizationId), visibility);
  return scoped
    .select()
    .from(inAppNotification)
    .where(filters)
    .orderBy(desc(inAppNotification.createdAt))
    .limit(Math.min(input.limit ?? 50, 200));
}

export async function countUnreadNotifications(
  scoped: Database,
  input: { organizationId: string; userId: string },
): Promise<number> {
  await assertTenantContext(scoped);
  const rows = await scoped
    .select({ count: sql<number>`count(*)::int` })
    .from(inAppNotification)
    .where(
      and(
        eq(inAppNotification.organizationId, input.organizationId),
        or(isNull(inAppNotification.userId), eq(inAppNotification.userId, input.userId)),
        isNull(inAppNotification.readAt),
      ),
    );
  return rows[0]?.count ?? 0;
}

export async function markNotificationRead(
  scoped: Database,
  input: { organizationId: string; userId: string; notificationId: string },
) {
  await assertTenantContext(scoped);
  const [row] = await scoped
    .update(inAppNotification)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(inAppNotification.id, input.notificationId),
        eq(inAppNotification.organizationId, input.organizationId),
        or(isNull(inAppNotification.userId), eq(inAppNotification.userId, input.userId)),
      ),
    )
    .returning({ id: inAppNotification.id });
  return Boolean(row);
}

export async function markAllNotificationsRead(
  scoped: Database,
  input: { organizationId: string; userId: string },
) {
  await assertTenantContext(scoped);
  await scoped
    .update(inAppNotification)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(inAppNotification.organizationId, input.organizationId),
        or(isNull(inAppNotification.userId), eq(inAppNotification.userId, input.userId)),
        isNull(inAppNotification.readAt),
      ),
    );
}
