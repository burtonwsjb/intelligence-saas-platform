import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  bootstrapRoles,
  createDbConnection,
  DB_ROLES,
  getSourceEvent,
  insertOutboxJob,
  insertSourceEvent,
  member,
  organization,
  replaceConnectionRole,
  requireDatabaseAdminUrl,
  tenant,
  user,
  withOrganizationContext,
  withSystemContext,
  type Database,
} from "@isp/db";
import { createNormalizeEnvelope, publishOutboxJob, requireRedisUrl } from "@isp/queue";
import { startWorker } from "./worker.js";

const passwords = {
  migrate: "isp_ci_migrate_only",
  user: "isp_ci_app_user_only",
  worker: "isp_ci_app_worker_only",
  admin: "isp_ci_app_admin_only",
};

const env = {
  ...process.env,
  NODE_ENV: "test",
  QUEUE_PREFIX: "phase05w",
};

async function waitUntil<T>(fn: () => Promise<T | null | undefined | false>, timeout = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await fn();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for worker.");
}

describe("BullMQ worker", () => {
  let adminConn: ReturnType<typeof createDbConnection>;
  let appConn: ReturnType<typeof createDbConnection>;
  let db: Database;
  let handle: { stop: () => Promise<void> };
  let orgId = "";
  let userId = "";

  beforeAll(async () => {
    requireRedisUrl(process.env);
    const adminUrl = requireDatabaseAdminUrl();
    await applyMigrations(adminUrl);
    await bootstrapRoles(adminUrl, passwords);
    adminConn = createDbConnection(adminUrl);
    appConn = createDbConnection(replaceConnectionRole(adminUrl, DB_ROLES.user, passwords.user));
    db = appConn.db;
    orgId = `org_${crypto.randomUUID()}`;
    userId = `user_${crypto.randomUUID()}`;
    await adminConn.db.insert(user).values({
      id: userId,
      name: "Worker",
      email: `${userId}@example.com`,
      emailVerified: true,
    });
    await adminConn.db.insert(organization).values({
      id: orgId,
      name: "Worker",
      slug: orgId,
    });
    await adminConn.db.insert(member).values({
      id: `mem_${orgId}`,
      organizationId: orgId,
      userId,
      role: "owner",
    });
    await adminConn.db.insert(tenant).values({
      organizationId: orgId,
      status: "active",
      createdByUserId: userId,
    });
    handle = startWorker({ db, env });
  }, 60_000);

  afterAll(async () => {
    await handle?.stop();
    await appConn?.end();
    await adminConn?.end();
  });

  it("processes a published normalize job for the matching tenant", async () => {
    const eventId = crypto.randomUUID();
    const outboxId = crypto.randomUUID();
    await withOrganizationContext(db, { organizationId: orgId, userId }, async (scoped) => {
      await insertSourceEvent(scoped, {
        id: eventId,
        organizationId: orgId,
        eventType: "pricing.snapshot",
        occurredAt: new Date("2026-08-16T00:00:00.000Z"),
        idempotencyKey: `idem_${crypto.randomUUID()}`,
        fingerprint: `fp_${crypto.randomUUID()}`,
        entity: { type: "sku", external_id: "sku_123" },
        metrics: [],
        payload: {},
      });
      await insertOutboxJob(scoped, {
        id: outboxId,
        organizationId: orgId,
        sourceEventId: eventId,
        jobType: "source_event.normalize",
        payload: createNormalizeEnvelope({
          jobId: outboxId,
          organizationId: orgId,
          sourceEventId: eventId,
        }),
      });
    });
    await publishOutboxJob(db, { organizationId: orgId, outboxId, env });
    const processed = await waitUntil(async () => {
      const row = await withSystemContext(db, { organizationId: orgId }, (scoped) =>
        getSourceEvent(scoped, { organizationId: orgId, id: eventId }),
      );
      return row?.processingStatus === "processed" ? row : null;
    });
    expect(processed.organizationId).toBe(orgId);
  });
});
