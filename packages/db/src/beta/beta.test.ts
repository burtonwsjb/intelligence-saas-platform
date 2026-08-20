import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  consumeBetaInvite,
  createBetaInvite,
  featureFlagEnabled,
  hashInviteToken,
  insertBugReport,
  insertProductEvent,
  insertProductFeedback,
  markOnboardingStep,
  member,
  organization,
  readMigrationSql,
  sanitizeOperatorText,
  tenant,
  user,
  BetaInviteError,
  type Database,
} from "../index.js";

async function setup() {
  const client = new PGlite();
  await client.exec(await readMigrationSql());
  const db = drizzle(client) as unknown as Database;
  await db.insert(user).values({
    id: "user_a",
    name: "A",
    email: "a@example.com",
    emailVerified: true,
  });
  await db.insert(organization).values({ id: "org_a", name: "Org A", slug: "org-a" });
  await db.insert(member).values({
    id: "mem_a",
    organizationId: "org_a",
    userId: "user_a",
    role: "owner",
  });
  await db.insert(tenant).values({
    organizationId: "org_a",
    status: "active",
    createdByUserId: "user_a",
  });
  return { db };
}

describe("beta invitations and sanitization", () => {
  it("hashes invite tokens and enforces expiry, max uses, and email match", async () => {
    const { db } = await setup();
    const created = await createBetaInvite(db, {
      email: "a@example.com",
      cohort: "alpha",
      expiresAt: new Date(Date.now() + 60_000),
      maxUses: 1,
      createdByUserId: "user_a",
    });
    expect(created.token).toBeTruthy();
    expect(created.token).not.toBe(hashInviteToken(created.token));
    await expect(
      consumeBetaInvite(db, { token: "not-a-real-token", email: "a@example.com" }),
    ).rejects.toThrow(BetaInviteError);
    const used = await consumeBetaInvite(db, { token: created.token, email: "a@example.com" });
    expect(used.cohort).toBe("alpha");
    await expect(consumeBetaInvite(db, { token: created.token, email: "a@example.com" })).rejects.toThrow(
      BetaInviteError,
    );

    const expired = await createBetaInvite(db, {
      expiresAt: new Date(Date.now() - 1000),
      createdByUserId: "user_a",
    });
    await expect(consumeBetaInvite(db, { token: expired.token })).rejects.toThrow(BetaInviteError);

    const mismatch = await createBetaInvite(db, {
      email: "other@example.com",
      expiresAt: new Date(Date.now() + 60_000),
      createdByUserId: "user_a",
    });
    await expect(consumeBetaInvite(db, { token: mismatch.token, email: "a@example.com" })).rejects.toThrow(
      BetaInviteError,
    );
  });

  it("tracks onboarding, sanitizes bug reports, and stores first-party events", async () => {
    const { db } = await setup();
    expect(await featureFlagEnabled(db, "predictions_customer_visible")).toBe(false);
    const onboarding = await markOnboardingStep(db, { organizationId: "org_a", step: "api_key" });
    expect(onboarding?.onboarding.api_key).toBe(true);
    const feedback = await insertProductFeedback(db, {
      organizationId: "org_a",
      userId: "user_a",
      category: "product",
      message: "Need clearer opportunity explanations.",
    });
    expect(feedback?.message).toContain("opportunity");
    const bug = await insertBugReport(db, {
      organizationId: "org_a",
      userId: "user_a",
      requestId: "req_12345678",
      route: "/app/opportunities",
      description: `Broke after pasting sk_live_notreal1234 into notes`,
    });
    expect(bug?.description).not.toMatch(/sk_live_/);
    expect(sanitizeOperatorText("Bearer abc.def.ghi secret")).toContain("[redacted]");
    const event = await insertProductEvent(db, {
      organizationId: "org_a",
      userId: "user_a",
      eventName: "dashboard.viewed",
    });
    expect(event?.eventName).toBe("dashboard.viewed");
  });
});
