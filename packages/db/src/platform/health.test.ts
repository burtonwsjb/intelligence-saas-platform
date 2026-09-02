import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  classifyWorkerHeartbeat,
  collectSystemHealth,
  readMigrationSql,
  tcgPrediction,
  upsertWorkerHeartbeat,
  withPlatformContext,
  type Database,
} from "../index.js";

async function setup() {
  const client = new PGlite();
  await client.exec(await readMigrationSql());
  return drizzle(client) as unknown as Database;
}

describe("worker heartbeat health", () => {
  it("classifies missing, stale, and healthy heartbeats", () => {
    const now = new Date("2026-08-29T00:02:00.000Z");
    expect(classifyWorkerHeartbeat(null, now)).toBe("missing");
    expect(classifyWorkerHeartbeat(undefined, now)).toBe("missing");
    expect(classifyWorkerHeartbeat(new Date("2026-08-29T00:00:50.000Z"), now)).toBe("stale");
    expect(classifyWorkerHeartbeat(new Date("2026-08-29T00:01:30.000Z"), now)).toBe("healthy");
  });

  it("rolls worker, queue, and provider states into an operator-safe overall status", async () => {
    const { classifyPlatformHealth, classifyQueueHealth, operatorGuidanceForHealth } = await import("./health.js");
    expect(classifyQueueHealth({ queueDepth: null, failedJobs: null })).toBe("unknown");
    expect(classifyQueueHealth({ queueDepth: 2, failedJobs: 0 })).toBe("healthy");
    expect(classifyQueueHealth({ queueDepth: 2, failedJobs: 25 })).toBe("degraded");
    expect(
      classifyPlatformHealth({ worker: "healthy", queue: "healthy", database: "error" }),
    ).toBe("failed");
    expect(classifyPlatformHealth({ worker: "missing", queue: "unknown" })).toBe("missing");
    expect(classifyPlatformHealth({ worker: "stale", queue: "healthy" })).toBe("stale");
    expect(classifyPlatformHealth({ worker: "healthy", queue: "degraded" })).toBe("degraded");
    expect(classifyPlatformHealth({ worker: "healthy", queue: "healthy", providerFailed: true })).toBe(
      "degraded",
    );
    expect(operatorGuidanceForHealth("missing")).toMatch(/APP_DATABASE_URL/);
    expect(operatorGuidanceForHealth("healthy")).not.toMatch(/postgresql:\/\//);
  });

  it("persists queueDepth and failedJobs and does not publish predictions", async () => {
    const db = await setup();
    await withPlatformContext(db, (scoped) =>
      upsertWorkerHeartbeat(scoped, { queueDepth: 4, failedJobs: 2 }),
    );
    const health = await collectSystemHealth(db);
    expect(health.version).toBe("health.v3");
    expect(health.status).toBe("healthy");
    expect(health.guidance).toMatch(/heartbeat is fresh/);
    expect(health.operations.workerHeartbeatStatus).toBe("healthy");
    expect(health.operations.queueHealth).toBe("healthy");
    expect(health.operations.queueDepth).toBe(4);
    expect(health.operations.failedJobs).toBe(2);
    expect(health.operations.workerHeartbeatAt).toBeTruthy();
    expect(health.providers.every((row) => row.mode === "disabled" || row.mode === undefined)).toBe(true);
    const published = await db.select().from(tcgPrediction);
    expect(published.filter((row) => row.visibility !== "shadow")).toHaveLength(0);
    expect(health.catalogs.predictions).toBe(0);
  });

  it("marks a stale ingest heartbeat", async () => {
    const db = await setup();
    await withPlatformContext(db, async (scoped) => {
      await upsertWorkerHeartbeat(scoped, { queueDepth: 1, failedJobs: 0 });
    });
    const { workerHeartbeat } = await import("../schema/provider.js");
    const { eq } = await import("drizzle-orm");
    await db
      .update(workerHeartbeat)
      .set({ lastSeenAt: new Date("2020-01-01T00:00:00.000Z") })
      .where(eq(workerHeartbeat.workerKey, "ingest"));
    const health = await collectSystemHealth(db);
    expect(health.status).toBe("stale");
    expect(health.operations.workerHeartbeatStatus).toBe("stale");
    expect(health.operations.queueDepth).toBe(1);
    expect(health.operations.failedJobs).toBe(0);
  });
});
