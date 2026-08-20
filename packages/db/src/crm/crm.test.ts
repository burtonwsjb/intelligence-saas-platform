import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  assignOrganizationTag,
  captureChurnReason,
  createAlertRule,
  createInAppNotification,
  countUnreadNotifications,
  ensureCrmOrganization,
  evaluateActivation,
  evaluateCustomerHealth,
  evaluateSegmentMembership,
  evaluateUsageWarnings,
  getCrmOrganizationProfile,
  insertEmailDelivery,
  insertOperatorNote,
  insertSegmentDefinition,
  listCrmCustomers,
  listCustomerEvents,
  listInAppNotifications,
  listNotificationPreferences,
  listOperatorNotes,
  listTrialCustomers,
  markAllNotificationsRead,
  markNotificationRead,
  member,
  organization,
  recordCustomerEvent,
  recordUsage,
  setNotificationPreference,
  tenant,
  transitionLifecycle,
  upsertCrmTag,
  user,
  withOrganizationContext,
  NotificationPreferenceDeniedError,
  OperatorNoteRejectedError,
  type Database,
  readMigrationSql,
} from "../index.js";

async function seedOrg(db: Database, ids = { org: "org_crm", user: "user_crm" }) {
  await db.insert(user).values({
    id: ids.user,
    name: "Owner",
    email: `${ids.user}@example.com`,
    emailVerified: true,
  });
  await db.insert(organization).values({ id: ids.org, name: "Acme", slug: ids.org });
  await db.insert(member).values({
    id: `mem_${ids.org}`,
    organizationId: ids.org,
    userId: ids.user,
    role: "owner",
  });
  await db.insert(tenant).values({
    organizationId: ids.org,
    status: "active",
    createdByUserId: ids.user,
  });
  return ids;
}

describe("CRM lifecycle and notifications", () => {
  it("covers signup, activation, trial, conversion, past_due, canceled, and reactivation", async () => {
    const client = new PGlite();
    await client.exec(await readMigrationSql());
    const db = drizzle(client) as unknown as Database;
    const ids = await seedOrg(db);

    await withOrganizationContext(db, { organizationId: ids.org, userId: ids.user }, async (scoped) => {
      await ensureCrmOrganization(scoped, {
        organizationId: ids.org,
        userId: ids.user,
        displayName: "Acme",
      });
      let profile = await getCrmOrganizationProfile(scoped, ids.org);
      expect(profile?.lifecycleStage).toBe("onboarding");
      const timeline = await listCustomerEvents(scoped, { organizationId: ids.org });
      expect(timeline.map((row) => row.eventType)).toEqual(
        expect.arrayContaining(["user.signed_up", "organization.created"]),
      );

      await recordCustomerEvent(scoped, {
        organizationId: ids.org,
        userId: ids.user,
        eventType: "api_key.created",
      });
      const activation = await evaluateActivation(scoped, ids.org);
      expect(activation.version).toBe("activation.v1");
      expect(activation.activated).toBe(true);
      profile = await getCrmOrganizationProfile(scoped, ids.org);
      expect(profile?.lifecycleStage).toBe("activated");
      expect(profile?.activatedAt).toBeTruthy();

      await transitionLifecycle(scoped, {
        organizationId: ids.org,
        toStage: "trial",
        reason: "trial.start",
        actorType: "billing",
      });
      await recordCustomerEvent(scoped, {
        organizationId: ids.org,
        eventType: "subscription.started",
        payload: { status: "trialing" },
      });
      profile = await getCrmOrganizationProfile(scoped, ids.org);
      expect(profile?.lifecycleStage).toBe("trial");

      await transitionLifecycle(scoped, {
        organizationId: ids.org,
        toStage: "customer",
        reason: "converted",
        actorType: "billing",
      });
      profile = await getCrmOrganizationProfile(scoped, ids.org);
      expect(profile?.customerStatus).toBe("active");
      expect(profile?.convertedAt).toBeTruthy();

      await transitionLifecycle(scoped, {
        organizationId: ids.org,
        toStage: "past_due",
        reason: "payment_failed",
        actorType: "billing",
      });
      await recordCustomerEvent(scoped, {
        organizationId: ids.org,
        eventType: "payment_failed",
      });
      profile = await getCrmOrganizationProfile(scoped, ids.org);
      expect(profile?.lifecycleStage).toBe("past_due");

      await captureChurnReason(scoped, {
        organizationId: ids.org,
        category: "too_expensive",
        note: "budget",
        capturedByUserId: ids.user,
        toStage: "canceled",
      });
      profile = await getCrmOrganizationProfile(scoped, ids.org);
      expect(profile?.lifecycleStage).toBe("canceled");

      await recordCustomerEvent(scoped, {
        organizationId: ids.org,
        eventType: "customer.reactivated",
      });
      await transitionLifecycle(scoped, {
        organizationId: ids.org,
        toStage: "customer",
        reason: "customer.reactivated",
        actorType: "billing",
      });
      profile = await getCrmOrganizationProfile(scoped, ids.org);
      expect(profile?.lifecycleStage).toBe("customer");
      expect(profile?.canceledAt).toBeNull();
    });
  });

  it("keeps operator notes private, supports tags/segments, and scores health explainably", async () => {
    const client = new PGlite();
    await client.exec(await readMigrationSql());
    const db = drizzle(client) as unknown as Database;
    const ids = await seedOrg(db, { org: "org_ops", user: "user_ops" });

    await withOrganizationContext(db, { organizationId: ids.org, userId: ids.user }, async (scoped) => {
      await ensureCrmOrganization(scoped, {
        organizationId: ids.org,
        userId: ids.user,
        displayName: "Ops",
      });
      await recordCustomerEvent(scoped, {
        organizationId: ids.org,
        eventType: "api_key.created",
      });
    });

    await expect(
      insertOperatorNote(db, {
        organizationId: ids.org,
        authorUserId: ids.user,
        category: "support",
        body: "sk_live_this_is_not_allowed",
      }),
    ).rejects.toThrow(OperatorNoteRejectedError);

    const note = await insertOperatorNote(db, {
      organizationId: ids.org,
      authorUserId: ids.user,
      category: "support",
      body: "Customer asked about indices.",
    });
    expect(note.body).toContain("indices");
    const notes = await listOperatorNotes(db, ids.org);
    expect(notes).toHaveLength(1);

    await upsertCrmTag(db, { key: "custom_vertical", label: "Custom vertical" });
    await assignOrganizationTag(db, { organizationId: ids.org, tagKey: "developer" });
    const segment = await insertSegmentDefinition(db, {
      key: "activated_developers",
      rules: {
        version: "segment.v1",
        all: [{ field: "lifecycle_stage", op: "eq", value: "activated" }],
      },
    });
    const members = await evaluateSegmentMembership(db, segment.id);
    expect(members).toContain(ids.org);
    const listed = await listCrmCustomers(db);
    expect(listed.some((row) => row.organizationId === ids.org)).toBe(true);
    const trials = await listTrialCustomers(db);
    expect(trials).toEqual([]);

    const health = await withOrganizationContext(db, { organizationId: ids.org, userId: ids.user }, (scoped) =>
      evaluateCustomerHealth(scoped, { organizationId: ids.org, billingStatus: "trialing", apiLimit: 1000 }),
    );
    expect(health.version).toBe("health.v1");
    expect(health.components.map((row) => row.key)).toEqual(
      expect.arrayContaining([
        "activation",
        "recent_activity",
        "api_usage",
        "errors",
        "webhook_health",
        "billing_health",
        "feature_adoption",
      ]),
    );
    expect(health.components.every((row) => row.reason.length > 0)).toBe(true);
  });

  it("enforces notification preferences, inbox RLS fields, usage warning dedupe, and delivery logs", async () => {
    const client = new PGlite();
    await client.exec(await readMigrationSql());
    const db = drizzle(client) as unknown as Database;
    const ids = await seedOrg(db, { org: "org_note", user: "user_note" });

    await withOrganizationContext(db, { organizationId: ids.org, userId: ids.user }, async (scoped) => {
      await ensureCrmOrganization(scoped, {
        organizationId: ids.org,
        userId: ids.user,
        displayName: "Notify",
      });
      const prefs = await listNotificationPreferences(scoped, {
        organizationId: ids.org,
        userId: ids.user,
      });
      expect(prefs.length).toBeGreaterThan(10);
      await expect(
        setNotificationPreference(scoped, {
          organizationId: ids.org,
          userId: ids.user,
          category: "security",
          channel: "email",
          optedIn: false,
        }),
      ).rejects.toThrow(NotificationPreferenceDeniedError);
      await setNotificationPreference(scoped, {
        organizationId: ids.org,
        userId: ids.user,
        category: "marketing",
        channel: "email",
        optedIn: false,
      });

      await createInAppNotification(scoped, {
        organizationId: ids.org,
        userId: ids.user,
        type: "usage.warning",
        title: "Usage",
        body: "You are at 50%.",
      });
      expect(await countUnreadNotifications(scoped, { organizationId: ids.org, userId: ids.user })).toBe(1);
      const inbox = await listInAppNotifications(scoped, {
        organizationId: ids.org,
        userId: ids.user,
        unreadOnly: true,
      });
      await markNotificationRead(scoped, {
        organizationId: ids.org,
        userId: ids.user,
        notificationId: inbox[0]!.id,
      });
      await markAllNotificationsRead(scoped, { organizationId: ids.org, userId: ids.user });
      expect(await countUnreadNotifications(scoped, { organizationId: ids.org, userId: ids.user })).toBe(0);

      await recordUsage(scoped, {
        id: "u1",
        organizationId: ids.org,
        meterKey: "api.reads",
        quantity: 50,
      });
      const first = await evaluateUsageWarnings(scoped, {
        organizationId: ids.org,
        userId: ids.user,
        meterKey: "api.reads",
        limit: 100,
      });
      expect(first).toEqual([50]);
      const second = await evaluateUsageWarnings(scoped, {
        organizationId: ids.org,
        userId: ids.user,
        meterKey: "api.reads",
        limit: 100,
      });
      expect(second).toEqual([]);

      await createAlertRule(scoped, {
        organizationId: ids.org,
        createdByUserId: ids.user,
        ruleType: "opportunity_score_threshold",
        config: { threshold: 80 },
      });

      const delivery = await insertEmailDelivery(scoped, {
        organizationId: ids.org,
        userId: ids.user,
        templateKey: "welcome",
        templateVersion: "mail.v1",
        provider: "local",
        status: "sent",
      });
      expect(delivery.status).toBe("sent");
      expect("html" in delivery).toBe(false);
    });
  });
});
