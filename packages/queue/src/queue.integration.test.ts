import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UnrecoverableError, Worker } from "bullmq";
import {
  applyMigrations,
  bootstrapRoles,
  createDbConnection,
  DB_ROLES,
  getOutboxJob,
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
import { createNormalizeEnvelope } from "./envelope.js";
import { UnrecoverableJobError } from "./errors.js";
import { requireRedisUrl } from "./env.js";
import { DEFAULT_JOB_ATTEMPTS } from "./names.js";
import { createIngestQueue, publishOutboxJob } from "./publisher.js";
import { dispatchPendingOutbox } from "./dispatcher.js";
import { markJobPermanentlyFailed, processNormalizeJob } from "./process.js";
import { createRedisConnection } from "./redis.js";
import { getIngestJobStatus } from "./status.js";

const passwords = {
  migrate: "isp_ci_migrate_only",
  user: "isp_ci_app_user_only",
  worker: "isp_ci_app_worker_only",
  admin: "isp_ci_app_admin_only",
};

const env = {
  ...process.env,
  NODE_ENV: "test",
  QUEUE_PREFIX: "phase05q",
};

async function waitUntil<T>(fn: () => Promise<T | null | undefined | false>, timeout = 12_000) {
  const started = Date.now();
  let last: T | null | undefined | false;
  while (Date.now() - started < timeout) {
    last = await fn();
    if (last) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for queue condition.");
}

describe("Redis + Postgres ingest queue", () => {
  let adminConn: ReturnType<typeof createDbConnection>;
  let appConn: ReturnType<typeof createDbConnection>;
  let db: Database;
  let orgA = "";
  let orgB = "";
  let userA = "";

  beforeAll(async () => {
    requireRedisUrl(process.env);
    const adminUrl = requireDatabaseAdminUrl();
    await applyMigrations(adminUrl);
    await bootstrapRoles(adminUrl, passwords);
    adminConn = createDbConnection(adminUrl);
    appConn = createDbConnection(replaceConnectionRole(adminUrl, DB_ROLES.user, passwords.user));
    db = appConn.db;
    orgA = `org_${crypto.randomUUID()}`;
    orgB = `org_${crypto.randomUUID()}`;
    userA = `user_${crypto.randomUUID()}`;
    const userB = `user_${crypto.randomUUID()}`;
    await adminConn.db.insert(user).values([
      { id: userA, name: "Queue A", email: `${userA}@example.com`, emailVerified: true },
      { id: userB, name: "Queue B", email: `${userB}@example.com`, emailVerified: true },
    ]);
    await adminConn.db.insert(organization).values([
      { id: orgA, name: "Queue A", slug: orgA },
      { id: orgB, name: "Queue B", slug: orgB },
    ]);
    await adminConn.db.insert(member).values([
      { id: `mem_${orgA}`, organizationId: orgA, userId: userA, role: "owner" },
      { id: `mem_${orgB}`, organizationId: orgB, userId: userB, role: "owner" },
    ]);
    await adminConn.db.insert(tenant).values([
      { organizationId: orgA, status: "active", createdByUserId: userA },
      { organizationId: orgB, status: "active", createdByUserId: userB },
    ]);
  }, 60_000);

  afterAll(async () => {
    await appConn?.end();
    await adminConn?.end();
  });

  async function seedEvent(organizationId: string, userId: string) {
    const eventId = crypto.randomUUID();
    const outboxId = crypto.randomUUID();
    await withOrganizationContext(db, { organizationId, userId }, async (scoped) => {
      await insertSourceEvent(scoped, {
        id: eventId,
        organizationId,
        eventType: "pricing.snapshot",
        occurredAt: new Date("2026-08-16T00:00:00.000Z"),
        idempotencyKey: `idem_${crypto.randomUUID()}`,
        fingerprint: `fp_${crypto.randomUUID()}`,
        entity: { type: "sku", external_id: "sku_123" },
        metrics: [],
        payload: { source: "generic_http" },
      });
      await insertOutboxJob(scoped, {
        id: outboxId,
        organizationId,
        sourceEventId: eventId,
        jobType: "source_event.normalize",
        payload: createNormalizeEnvelope({
          jobId: outboxId,
          organizationId,
          sourceEventId: eventId,
          requestId: "req_phase05_queue",
        }),
      });
    });
    return { eventId, outboxId };
  }

  it("keeps accepted work durable when Redis is unavailable and publishes later", async () => {
    const { eventId, outboxId } = await seedEvent(orgA, userA);
    await expect(
      publishOutboxJob(db, {
        organizationId: orgA,
        outboxId,
        env: { ...env, REDIS_URL: "redis://127.0.0.1:59999" },
      }),
    ).rejects.toThrow(/Redis queue is unavailable/);

    const pending = await withSystemContext(db, { organizationId: orgA }, (scoped) =>
      getSourceEvent(scoped, { organizationId: orgA, id: eventId }),
    );
    expect(pending?.processingStatus).toBe("received");
    const outbox = await withSystemContext(db, { organizationId: orgA }, (scoped) =>
      getOutboxJob(scoped, { organizationId: orgA, id: outboxId }),
    );
    expect(outbox?.status).toBe("pending");

    const queue = createIngestQueue(env);
    try {
      const first = await publishOutboxJob(db, {
        organizationId: orgA,
        outboxId,
        queue,
        env,
      });
      const second = await publishOutboxJob(db, {
        organizationId: orgA,
        outboxId,
        queue,
        env,
      });
      expect(first.published).toBe(true);
      expect(second.published).toBe(true);
    } finally {
      await queue.close();
    }
  });

  it("dispatches pending outbox and processes a valid tenant-bound job", async () => {
    const { eventId, outboxId } = await seedEvent(orgA, userA);
    const queue = createIngestQueue(env);
    const connection = createRedisConnection(env);
    const worker = new Worker(
      queue.name,
      async (job) => {
        try {
          await processNormalizeJob(db, job.data, job.attemptsMade + 1);
        } catch (error) {
          if (error instanceof UnrecoverableJobError) {
            throw new UnrecoverableError(error.message);
          }
          throw error;
        }
      },
      { connection, concurrency: 1 },
    );
    try {
      const dispatched = await dispatchPendingOutbox(db, { queue, env, limit: 50 });
      expect(dispatched.published).toBeGreaterThanOrEqual(1);
      const processed = await waitUntil(async () => {
        const row = await withSystemContext(db, { organizationId: orgA }, (scoped) =>
          getSourceEvent(scoped, { organizationId: orgA, id: eventId }),
        );
        return row?.processingStatus === "processed" ? row : null;
      });
      expect(processed.processingStatus).toBe("processed");
      const status = await getIngestJobStatus(db, { organizationId: orgA, sourceEventId: eventId });
      expect(status.outbox.some((job) => job.id === outboxId && job.status === "published")).toBe(
        true,
      );
    } finally {
      await worker.close();
      connection.disconnect();
      await queue.close();
    }
  });

  it("rejects cross-tenant jobs permanently and persists failed status", async () => {
    const { eventId } = await seedEvent(orgA, userA);
    const envelope = createNormalizeEnvelope({
      jobId: crypto.randomUUID(),
      organizationId: orgB,
      sourceEventId: eventId,
      requestId: "req_phase05_cross",
    });
    await expect(processNormalizeJob(db, envelope)).rejects.toBeInstanceOf(UnrecoverableJobError);

    const ownEnvelope = createNormalizeEnvelope({
      jobId: crypto.randomUUID(),
      organizationId: orgA,
      sourceEventId: crypto.randomUUID(),
      requestId: "req_phase05_missing",
    });
    await expect(processNormalizeJob(db, ownEnvelope)).rejects.toBeInstanceOf(UnrecoverableJobError);

    const failEnvelope = createNormalizeEnvelope({
      jobId: crypto.randomUUID(),
      organizationId: orgA,
      sourceEventId: eventId,
      requestId: "req_phase05_fail",
    });
    await markJobPermanentlyFailed(db, failEnvelope, "invalid job schema");
    const failed = await withSystemContext(db, { organizationId: orgA }, (scoped) =>
      getSourceEvent(scoped, { organizationId: orgA, id: eventId }),
    );
    expect(failed?.processingStatus).toBe("failed");
    expect(failed?.failureCategory).toBe("permanent");
    expect(failed?.failureMessage).not.toMatch(/isp_test_/);
  });

  it("does not infinitely retry permanent invalid jobs and bounds transient retries", async () => {
    expect(DEFAULT_JOB_ATTEMPTS).toBe(5);
    const queue = createIngestQueue(env);
    const connection = createRedisConnection(env);
    const worker = new Worker(
      queue.name,
      async (job) => {
        if (job.id?.startsWith("permanent-")) {
          throw new UnrecoverableError("Invalid job envelope.");
        }
        throw new Error("transient redis/network");
      },
      { connection, concurrency: 2 },
    );
    try {
      const permanent = await queue.add(
        "source_event.normalize",
        createNormalizeEnvelope({
          jobId: `permanent-${crypto.randomUUID()}`,
          organizationId: orgA,
          sourceEventId: crypto.randomUUID(),
        }),
        { jobId: `permanent-${crypto.randomUUID()}` },
      );
      const transient = await queue.add(
        "source_event.normalize",
        createNormalizeEnvelope({
          jobId: `transient-${crypto.randomUUID()}`,
          organizationId: orgA,
          sourceEventId: crypto.randomUUID(),
        }),
        {
          jobId: `transient-${crypto.randomUUID()}`,
          attempts: 2,
          backoff: { type: "fixed", delay: 50 },
        },
      );
      await waitUntil(async () => ((await permanent.getState()) === "failed" ? true : null));
      const permanentFresh = await queue.getJob(permanent.id!);
      expect((permanentFresh?.attemptsMade ?? 0) <= 1).toBe(true);
      await waitUntil(async () => ((await transient.getState()) === "failed" ? true : null));
      const transientFresh = await queue.getJob(transient.id!);
      expect(transientFresh?.attemptsMade).toBe(2);
    } finally {
      await worker.close();
      connection.disconnect();
      await queue.close();
    }
  });
});
