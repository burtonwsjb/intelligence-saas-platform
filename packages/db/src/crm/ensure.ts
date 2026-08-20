import type { Database } from "../client.js";
import { recordCustomerEvent } from "./events.js";
import { seedNotificationPreferences } from "../notifications/preferences.js";
import { transitionLifecycle } from "./profile.js";
import { upsertCrmOrganizationProfile } from "./profile.js";
import { upsertCrmUserProfile } from "./user-profile.js";

export async function ensureCrmOrganization(
  scoped: Database,
  input: {
    organizationId: string;
    userId: string;
    displayName: string;
    signupSource?: string;
  },
) {
  await upsertCrmOrganizationProfile(scoped, {
    organizationId: input.organizationId,
    displayName: input.displayName,
    signupSource: input.signupSource ?? "self_serve",
  });
  await upsertCrmUserProfile(scoped, {
    organizationId: input.organizationId,
    userId: input.userId,
  });
  await seedNotificationPreferences(scoped, {
    organizationId: input.organizationId,
    userId: input.userId,
  });
  await recordCustomerEvent(scoped, {
    organizationId: input.organizationId,
    userId: input.userId,
    eventType: "user.signed_up",
    idempotencyKey: `user.signed_up:${input.userId}`,
  });
  await recordCustomerEvent(scoped, {
    organizationId: input.organizationId,
    userId: input.userId,
    eventType: "organization.created",
    idempotencyKey: "organization.created",
  });
  await transitionLifecycle(scoped, {
    organizationId: input.organizationId,
    toStage: "onboarding",
    reason: "organization.created",
    actorType: "system",
  });
}
