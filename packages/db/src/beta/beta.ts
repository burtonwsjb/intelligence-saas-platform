import { createHash, randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import {
  betaInvitation,
  betaOrganization,
  bugReport,
  platformFeatureFlags,
  productEvent,
  productFeedback,
} from "../schema/index.js";

export const FEATURE_FLAG_KEYS = [
  "predictions_customer_visible",
  "content_publication",
  "creator_intelligence",
  "webhooks",
  "beta_only_features",
] as const;
export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number];

export const BETA_COHORTS = ["internal", "alpha", "beta_wave_1", "beta_wave_2"] as const;
export type BetaCohort = (typeof BETA_COHORTS)[number];

export const ONBOARDING_STEPS = [
  "account_verified",
  "organization_created",
  "use_case",
  "api_key",
  "first_event",
  "first_intelligence",
  "webhook_optional",
  "notification_settings",
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const PRODUCT_EVENT_NAMES = [
  "dashboard.viewed",
  "opportunity.opened",
  "creator.viewed",
  "api_key.created",
  "webhook.created",
  "alert.created",
  "content.viewed",
] as const;
export type ProductEventName = (typeof PRODUCT_EVENT_NAMES)[number];

const SECRET_PATTERN =
  /sk_live_|sk_test_|whsec_|isp_(?:test|live)_[A-Za-z0-9]+|BETTER_AUTH_SECRET|API_KEY_PEPPER|password\s*=|Bearer\s+[A-Za-z0-9._-]+/i;

export class BetaInviteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BetaInviteError";
  }
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sanitizeOperatorText(value: string, max = 4000): string {
  const cleaned = value.replace(SECRET_PATTERN, "[redacted]").trim();
  return cleaned.slice(0, max);
}

export function isFeatureFlagKey(value: string): value is FeatureFlagKey {
  return (FEATURE_FLAG_KEYS as readonly string[]).includes(value);
}

export function isBetaCohort(value: string): value is BetaCohort {
  return (BETA_COHORTS as readonly string[]).includes(value);
}

export function isProductEventName(value: string): value is ProductEventName {
  return (PRODUCT_EVENT_NAMES as readonly string[]).includes(value);
}

export async function listFeatureFlags(db: Database) {
  return db.select().from(platformFeatureFlags);
}

export async function featureFlagEnabled(db: Database, key: FeatureFlagKey): Promise<boolean> {
  const [row] = await db
    .select({ enabled: platformFeatureFlags.enabled })
    .from(platformFeatureFlags)
    .where(eq(platformFeatureFlags.flagKey, key))
    .limit(1);
  return row?.enabled === true;
}

export async function setFeatureFlag(
  db: Database,
  input: { key: FeatureFlagKey; enabled: boolean; actorUserId: string },
) {
  const [row] = await db
    .insert(platformFeatureFlags)
    .values({
      flagKey: input.key,
      enabled: input.enabled,
      updatedAt: new Date(),
      updatedByUserId: input.actorUserId,
    })
    .onConflictDoUpdate({
      target: platformFeatureFlags.flagKey,
      set: {
        enabled: input.enabled,
        updatedAt: new Date(),
        updatedByUserId: input.actorUserId,
      },
    })
    .returning();
  return row;
}

export async function createBetaInvite(
  db: Database,
  input: {
    email?: string | null;
    organizationHint?: string | null;
    cohort?: string;
    expiresAt: Date;
    maxUses?: number;
    createdByUserId: string;
  },
) {
  const cohort = input.cohort ?? "beta_wave_1";
  if (!isBetaCohort(cohort)) {
    throw new BetaInviteError("Unknown beta cohort.");
  }
  const token = generateInviteToken();
  const id = `binv_${randomBytes(8).toString("hex")}`;
  await db.insert(betaInvitation).values({
    id,
    tokenHash: hashInviteToken(token),
    email: input.email?.trim().toLowerCase() || null,
    organizationHint: input.organizationHint?.trim() || null,
    cohort,
    expiresAt: input.expiresAt,
    maxUses: input.maxUses ?? 1,
    createdByUserId: input.createdByUserId,
  });
  return { id, token };
}

export async function consumeBetaInvite(
  db: Database,
  input: { token: string; email?: string | null },
) {
  const token = input.token?.trim();
  if (!token) {
    throw new BetaInviteError("Beta invitation is required.");
  }
  const hash = hashInviteToken(token);
  try {
    const rows = await db.execute(sql`
      select invite_id, cohort, organization_hint
      from app.consume_beta_invite(${hash}, ${input.email?.trim().toLowerCase() ?? null})
    `);
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    const row = list[0] as
      | { invite_id?: string; cohort?: string; organization_hint?: string }
      | undefined;
    if (!row?.invite_id) {
      throw new BetaInviteError("Beta invitation is invalid.");
    }
    return {
      id: String(row.invite_id),
      cohort: String(row.cohort),
      organizationHint: row.organization_hint ? String(row.organization_hint) : null,
    };
  } catch (error) {
    if (error instanceof BetaInviteError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "";
    if (/expired/i.test(message)) {
      throw new BetaInviteError("Beta invitation has expired.");
    }
    if (/remaining uses/i.test(message)) {
      throw new BetaInviteError("Beta invitation has no remaining uses.");
    }
    if (/email/i.test(message)) {
      throw new BetaInviteError("Beta invitation email does not match.");
    }
    throw new BetaInviteError("Beta invitation is invalid.");
  }
}

export async function upsertBetaOrganization(
  db: Database,
  input: {
    organizationId: string;
    cohort?: string;
    useCase?: string | null;
    onboarding?: Record<string, unknown>;
  },
) {
  const cohort = input.cohort ?? "internal";
  if (!isBetaCohort(cohort)) {
    throw new BetaInviteError("Unknown beta cohort.");
  }
  const [row] = await db
    .insert(betaOrganization)
    .values({
      organizationId: input.organizationId,
      cohort,
      useCase: input.useCase ?? null,
      onboarding: input.onboarding ?? {},
    })
    .onConflictDoUpdate({
      target: betaOrganization.organizationId,
      set: {
        cohort,
        useCase: input.useCase ?? null,
        onboarding: input.onboarding ?? {},
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

export async function markOnboardingStep(
  db: Database,
  input: { organizationId: string; step: OnboardingStep; value?: unknown },
) {
  if (!(ONBOARDING_STEPS as readonly string[]).includes(input.step)) {
    throw new BetaInviteError("Unknown onboarding step.");
  }
  const existing = await db
    .select()
    .from(betaOrganization)
    .where(eq(betaOrganization.organizationId, input.organizationId))
    .limit(1);
  const current = (existing[0]?.onboarding ?? {}) as Record<string, unknown>;
  current[input.step] = input.value ?? true;
  const completed = ONBOARDING_STEPS.every((step) => current[step]);
  current.completed = completed;
  return upsertBetaOrganization(db, {
    organizationId: input.organizationId,
    cohort: existing[0]?.cohort ?? "internal",
    useCase: existing[0]?.useCase,
    onboarding: current,
  });
}

export async function insertProductFeedback(
  db: Database,
  input: {
    organizationId: string;
    userId: string;
    category: string;
    pageContext?: string | null;
    severity?: string;
    message: string;
    supportCaseId?: string | null;
  },
) {
  const message = sanitizeOperatorText(input.message);
  if (message.length < 8) {
    throw new BetaInviteError("Feedback is too short.");
  }
  const [row] = await db
    .insert(productFeedback)
    .values({
      id: `fb_${randomBytes(8).toString("hex")}`,
      organizationId: input.organizationId,
      userId: input.userId,
      category: input.category,
      pageContext: input.pageContext ?? null,
      severity: input.severity ?? "normal",
      message,
      supportCaseId: input.supportCaseId ?? null,
    })
    .returning();
  return row;
}

export async function insertBugReport(
  db: Database,
  input: {
    organizationId: string;
    userId: string;
    requestId?: string | null;
    route?: string | null;
    browser?: string | null;
    description: string;
    reproduction?: string | null;
    supportCaseId?: string | null;
  },
) {
  const description = sanitizeOperatorText(input.description);
  if (description.length < 8) {
    throw new BetaInviteError("Bug report is too short.");
  }
  const [row] = await db
    .insert(bugReport)
    .values({
      id: `bug_${randomBytes(8).toString("hex")}`,
      organizationId: input.organizationId,
      userId: input.userId,
      requestId: input.requestId?.slice(0, 128) ?? null,
      route: input.route?.slice(0, 200) ?? null,
      browser: sanitizeOperatorText(input.browser ?? "", 200) || null,
      description,
      reproduction: input.reproduction ? sanitizeOperatorText(input.reproduction) : null,
      supportCaseId: input.supportCaseId ?? null,
    })
    .returning();
  return row;
}

export async function insertProductEvent(
  db: Database,
  input: { organizationId: string; userId?: string | null; eventName: string },
) {
  if (!isProductEventName(input.eventName)) {
    throw new BetaInviteError("Unknown product event.");
  }
  const [row] = await db
    .insert(productEvent)
    .values({
      id: `pevt_${randomBytes(8).toString("hex")}`,
      organizationId: input.organizationId,
      userId: input.userId ?? null,
      eventName: input.eventName,
    })
    .returning();
  return row;
}
