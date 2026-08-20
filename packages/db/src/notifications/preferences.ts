import { and, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { assertTenantContext } from "../rls.js";
import { notificationPreference } from "../schema/notification.js";
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  defaultOptedIn,
  isNotificationCategory,
  isNotificationChannel,
  isRequiredNotificationCategory,
  type NotificationCategory,
  type NotificationChannel,
} from "./catalog.js";

export class NotificationPreferenceDeniedError extends Error {
  constructor() {
    super("This notification category cannot be disabled.");
    this.name = "NotificationPreferenceDeniedError";
  }
}

export async function seedNotificationPreferences(
  scoped: Database,
  input: { organizationId: string; userId: string },
) {
  await assertTenantContext(scoped);
  for (const category of NOTIFICATION_CATEGORIES) {
    for (const channel of NOTIFICATION_CHANNELS) {
      await scoped
        .insert(notificationPreference)
        .values({
          organizationId: input.organizationId,
          userId: input.userId,
          category,
          channel,
          optedIn: defaultOptedIn(category, channel),
        })
        .onConflictDoNothing();
    }
  }
}

export async function listNotificationPreferences(
  scoped: Database,
  input: { organizationId: string; userId: string },
) {
  await assertTenantContext(scoped);
  return scoped
    .select()
    .from(notificationPreference)
    .where(
      and(
        eq(notificationPreference.organizationId, input.organizationId),
        eq(notificationPreference.userId, input.userId),
      ),
    );
}

export async function setNotificationPreference(
  scoped: Database,
  input: {
    organizationId: string;
    userId: string;
    category: string;
    channel: string;
    optedIn: boolean;
  },
) {
  await assertTenantContext(scoped);
  if (!isNotificationCategory(input.category) || !isNotificationChannel(input.channel)) {
    throw new Error("Unknown notification preference.");
  }
  if (!input.optedIn && isRequiredNotificationCategory(input.category)) {
    throw new NotificationPreferenceDeniedError();
  }
  await scoped
    .insert(notificationPreference)
    .values({
      organizationId: input.organizationId,
      userId: input.userId,
      category: input.category,
      channel: input.channel,
      optedIn: input.optedIn,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        notificationPreference.organizationId,
        notificationPreference.userId,
        notificationPreference.category,
        notificationPreference.channel,
      ],
      set: { optedIn: input.optedIn, updatedAt: new Date() },
    });
}

export async function isChannelOptedIn(
  scoped: Database,
  input: {
    organizationId: string;
    userId: string;
    category: NotificationCategory;
    channel: NotificationChannel;
  },
): Promise<boolean> {
  if (isRequiredNotificationCategory(input.category) && input.channel !== "webhook") {
    return true;
  }
  const [row] = await scoped
    .select({ optedIn: notificationPreference.optedIn })
    .from(notificationPreference)
    .where(
      and(
        eq(notificationPreference.organizationId, input.organizationId),
        eq(notificationPreference.userId, input.userId),
        eq(notificationPreference.category, input.category),
        eq(notificationPreference.channel, input.channel),
      ),
    )
    .limit(1);
  if (!row) {
    return defaultOptedIn(input.category, input.channel);
  }
  return row.optedIn;
}
