import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  assertDisposableAdminUrl,
  bootstrapRoles,
  createDbConnection,
  DB_ROLES,
  getSourceEvent,
  enqueuePlatformJob,
  getPlatformOutbox,
  markPlatformOutboxPublished,
  getObservationBySourceEvent,
  getWorkerHeartbeat,
  insertOutboxJob,
  insertSourceEvent,
  member,
  organization,
  replaceConnectionRole,
  requireDatabaseAdminUrl,
  testRolePasswords,
  tenant,
  user,
  withOrganizationContext,
  withPlatformContext,
  withSystemContext,
  type Database,
} from "@isp/db";
import { bullmqJobId, createIngestQueue, createNormalizeEnvelope, createProviderSyncEnvelope, publishOutboxJob, requireRedisUrl } from "@isp/queue";
import { inspectRetainedFailures } from "./failure-observation.js";
import { startWorker } from "./worker.js";

const passwords = testRolePasswords();

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
  let workerConn: ReturnType<typeof createDbConnection>;
  let db: Database;
  let handle: { stop: () => Promise<void> };
  let orgId = "";
  let userId = "";

  beforeAll(async () => {
    requireRedisUrl(process.env);
    const adminUrl = requireDatabaseAdminUrl();
    assertDisposableAdminUrl(adminUrl);
    await applyMigrations(adminUrl);
    await bootstrapRoles(adminUrl, passwords);
    adminConn = createDbConnection(adminUrl);
    appConn = createDbConnection(replaceConnectionRole(adminUrl, DB_ROLES.user, passwords.user));
    workerConn = createDbConnection(replaceConnectionRole(adminUrl, DB_ROLES.worker, passwords.worker));
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
    handle = startWorker({ db: workerConn.db, env });
  }, 60_000);

  afterAll(async () => {
    await handle?.stop();
    await workerConn?.end();
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
        metrics: [{ key: "price.usd", value: 9.5, unit: "usd" }],
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
    const observation = await withSystemContext(db, { organizationId: orgId }, (scoped) =>
      getObservationBySourceEvent(scoped, { organizationId: orgId, sourceEventId: eventId }),
    );
    expect(observation?.sourceEventId).toBe(eventId);
    expect(observation?.observationType).toBe("metric.snapshot");
  });

  it("records an exhausted platform job in Postgres and preserves its Redis evidence", async () => {
    const queue = createIngestQueue(env);
    try {
      const id = `terminal_${crypto.randomUUID()}`;
      // Unknown provider fails before HTTP. This tests actual retry exhaustion,
      // not a live vendor request or injected fixture result in hosted staging.
      const payload = createProviderSyncEnvelope({ jobId: id, providerKey: "invalid_provider" });
      await withPlatformContext(adminConn.db, async (tx) => {
        await enqueuePlatformJob(tx, { id, jobType: "provider.sync.v1", payload });
        await markPlatformOutboxPublished(tx, id);
      });
      const job = await queue.add("provider.sync.v1", payload, {
        jobId: bullmqJobId(id), attempts: 2, backoff: { type: "fixed", delay: 50 }, removeOnFail: false,
      });
      const failed = await waitUntil(async () => {
        const row = await withPlatformContext(adminConn.db, (tx) => getPlatformOutbox(tx, id));
        return row?.status === "failed" ? row : null;
      });
      expect(failed.lastError).toBe("unknown");
      expect(await job.getState()).toBe("failed");
      const retained = await queue.getJob(job.id!);
      expect(retained?.attemptsMade).toBe(2);
      expect(retained?.failedReason).toBeTruthy();
      const sample = await inspectRetainedFailures(queue);
      expect(sample.status).toBe("inspected");
      expect(sample.groups.some((group) => group.jobType === "provider.sync.v1" && group.count >= 1)).toBe(true);
      expect(await job.getState()).toBe("failed");
    } finally {
      await queue.close();
    }
  });

  it("persists numeric queue metrics once Redis answers", async () => {
    const row = await waitUntil(async () => {
      const heartbeat = await withPlatformContext(workerConn.db, (scoped) => getWorkerHeartbeat(scoped));
      return heartbeat?.queueDepth != null && heartbeat.failedJobs != null ? heartbeat : null;
    });
    expect(row.queueDepth).toBeGreaterThanOrEqual(0);
    expect(row.failedJobs).toBeGreaterThanOrEqual(0);
  });
});
