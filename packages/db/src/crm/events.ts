import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { assertTenantContext } from "../rls.js";
import { crmCustomerEvent, crmOrganizationProfile } from "../schema/crm.js";
import {
  isCustomerEventType,
  type CustomerEventType,
} from "./catalog.js";
import { evaluateActivation } from "./activation.js";
import { ACTIVATION_RULE_VERSION } from "./catalog.js";

export class UnknownCustomerEventTypeError extends Error {
  constructor() {
    super("Unknown customer event type.");
    this.name = "UnknownCustomerEventTypeError";
  }
}

const SECRET_PATTERN = /sk_live_|sk_test_|whsec_|isp_(?:test|live)_[A-Za-z0-9]+|RESEND_API_KEY|password\s*=/i;

export function assertSafeCustomerPayload(payload: Record<string, unknown>): void {
  const serialized = JSON.stringify(payload);
  if (SECRET_PATTERN.test(serialized)) {
    throw new Error("Customer event payload must not contain secrets.");
  }
}

export async function recordCustomerEvent(
  scoped: Database,
  input: {
    organizationId: string;
    userId?: string | null;
    eventType: CustomerEventType | string;
    idempotencyKey?: string | null;
    payload?: Record<string, unknown>;
    occurredAt?: Date;
  },
): Promise<{ id: string; inserted: boolean }> {
  await assertTenantContext(scoped);
  if (!isCustomerEventType(input.eventType)) {
    throw new UnknownCustomerEventTypeError();
  }
  const payload = input.payload ?? {};
  assertSafeCustomerPayload(payload);
  const id = crypto.randomUUID();
  const inserted = await scoped
    .insert(crmCustomerEvent)
    .values({
      id,
      organizationId: input.organizationId,
      userId: input.userId ?? null,
      eventType: input.eventType,
      idempotencyKey: input.idempotencyKey ?? null,
      payload,
      createdAt: input.occurredAt ?? new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: crmCustomerEvent.id });
  const rowId = inserted[0]?.id ?? id;
  if (inserted.length > 0) {
    const now = input.occurredAt ?? new Date();
    const [profile] = await scoped
      .select()
      .from(crmOrganizationProfile)
      .where(eq(crmOrganizationProfile.organizationId, input.organizationId))
      .limit(1);
    const activation = await evaluateActivation(scoped, input.organizationId);
    await scoped
      .update(crmOrganizationProfile)
      .set({
        lastActivityAt: now,
        activatedAt: activation.activated ? (profile?.activatedAt ?? now) : profile?.activatedAt ?? null,
        activationRuleVersion: activation.activated
          ? ACTIVATION_RULE_VERSION
          : profile?.activationRuleVersion ?? null,
      })
      .where(eq(crmOrganizationProfile.organizationId, input.organizationId));
    if (
      activation.activated &&
      profile &&
      (profile.lifecycleStage === "signup" || profile.lifecycleStage === "onboarding")
    ) {
      const { transitionLifecycle } = await import("./profile.js");
      await transitionLifecycle(scoped, {
        organizationId: input.organizationId,
        toStage: "activated",
        reason: ACTIVATION_RULE_VERSION,
        actorType: "system",
      });
    }
  }
  return { id: rowId, inserted: inserted.length > 0 };
}

export async function listCustomerEvents(
  scoped: Database,
  input: { organizationId: string; limit?: number },
) {
  await assertTenantContext(scoped);
  return scoped
    .select()
    .from(crmCustomerEvent)
    .where(eq(crmCustomerEvent.organizationId, input.organizationId))
    .orderBy(desc(crmCustomerEvent.createdAt))
    .limit(Math.min(input.limit ?? 100, 200));
}

export async function hasCustomerEvent(
  scoped: Database,
  input: { organizationId: string; eventType: CustomerEventType },
): Promise<boolean> {
  await assertTenantContext(scoped);
  const [row] = await scoped
    .select({ id: crmCustomerEvent.id })
    .from(crmCustomerEvent)
    .where(
      and(
        eq(crmCustomerEvent.organizationId, input.organizationId),
        eq(crmCustomerEvent.eventType, input.eventType),
      ),
    )
    .limit(1);
  return Boolean(row);
}
