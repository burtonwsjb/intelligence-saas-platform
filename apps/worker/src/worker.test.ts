import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { MissingRedisUrlError } from "@isp/queue";
import {
  collectQueueCounts,
  reconcileProviderRuntimeFromEnv,
  runProviderSchedule,
  runCallScoring,
  runTccCatalogImport,
  runWorkerHeartbeat,
  startProviderScheduleLoop,
  startWorker,
  workerHealthPayload,
} from "./worker.js";

type HeartbeatRow = {
  queueDepth: number | null;
  failedJobs: number | null;
  metadata?: { role?: string; queue_metrics_error_class?: string | null };
};

function capturingHeartbeatDb(rows: HeartbeatRow[]) {
  return {
    transaction: async (
      run: (tx: { execute: () => Promise<unknown>; insert: () => unknown }) => Promise<unknown>,
    ) =>
      run({
        execute: async () => [],
        insert: () => ({
          values: (input: HeartbeatRow) => ({
            onConflictDoUpdate: async () => {
              rows.push(input);
            },
          }),
        }),
      }),
  };
}

describe("startWorker", () => {
  it("fails clearly when Redis is not configured", () => {
    expect(() => startWorker({ env: { NODE_ENV: "test" } })).toThrow(MissingRedisUrlError);
  });
});

describe("collectQueueCounts", () => {
  it("returns 0 / 0 for an empty queue", async () => {
    await expect(
      collectQueueCounts({ getJobCounts: async () => ({ waiting: 0, active: 0, failed: 0 }) }),
    ).resolves.toEqual({ queueDepth: 0, failedJobs: 0, errorClass: null });
  });

  it("sums waiting and active jobs", async () => {
    await expect(
      collectQueueCounts({ getJobCounts: async () => ({ waiting: 2, active: 1, failed: 0 }) }),
    ).resolves.toEqual({ queueDepth: 3, failedJobs: 0, errorClass: null });
    await expect(
      collectQueueCounts({ getJobCounts: async () => ({ wait: 4, active: 1, failed: 0 }) }),
    ).resolves.toEqual({ queueDepth: 5, failedJobs: 0, errorClass: null });
  });

  it("reads failed jobs", async () => {
    await expect(
      collectQueueCounts({ getJobCounts: async () => ({ waiting: 0, active: 0, failed: 9 }) }),
    ).resolves.toEqual({ queueDepth: 0, failedJobs: 9, errorClass: null });
  });

  it("returns null metrics and a timeout class when Redis hangs", async () => {
    const result = await collectQueueCounts(
      { getJobCounts: () => new Promise(() => undefined) },
      { timeoutMs: 20 },
    );
    expect(result).toEqual({ queueDepth: null, failedJobs: null, errorClass: "timeout" });
  });
});

describe("worker operational loops", () => {
  it("persists a sanitized failure sample without waiting for inspection during heartbeat", async () => {
    const rows: HeartbeatRow[] = [];
    const snapshot = { version: "queue-failures.v1" as const, status: "inspected" as const,
      sampledAt: "2026-09-07T03:00:00.000Z", retainedCountAtRead: 0,
      sampleLimit: 100, sampledJobs: 0, truncated: false, errorClass: null, groups: [] };
    await runWorkerHeartbeat(capturingHeartbeatDb(rows) as never,
      { getJobCounts: async () => ({ wait: 0, active: 0, failed: 0 }) },
      { queueFailureSnapshot: { ...snapshot, secret: "DO_NOT_PERSIST" } as typeof snapshot });
    expect(rows[0]?.metadata).toMatchObject({ queue_failure_sample: snapshot });
    expect(JSON.stringify(rows)).not.toContain("DO_NOT_PERSIST");
  });

  it("continues scheduling after a heartbeat failure and logs a sanitized error", async () => {
    const secret = "postgresql://app_worker:hunter2@db.example/isp";
    const heartbeatError = Object.assign(new Error(`Failed query ${secret}`), {
      cause: Object.assign(new Error("permission denied for table worker_heartbeat"), { code: "42501" }),
    });
    const scheduleDb = {
      transaction: async (run: (tx: { execute: () => Promise<unknown> }) => Promise<unknown>) =>
        run({ execute: async () => [] }),
    };
    const failingDb = {
      transaction: async () => {
        throw heartbeatError;
      },
    };
    const queue = {
      getJobCounts: async () => ({ wait: 2, active: 1, failed: 5 }),
    };
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line) => {
      lines.push(String(line));
    });

    await runProviderSchedule(scheduleDb as never, { ISP_ENV: "staging" });
    await runWorkerHeartbeat(failingDb as never, queue);
    await runProviderSchedule(scheduleDb as never, { ISP_ENV: "staging" });

    const blob = lines.join("\n");
    expect(blob).toContain("worker.heartbeat_failed");
    expect(blob).toContain("permission_denied");
    expect(blob).toContain("next_cycle");
    expect(blob).not.toContain("hunter2");
    expect(blob).not.toContain("postgresql://");
    spy.mockRestore();
  });

  it("skips call scoring while another replica holds the lock and never throws", async () => {
    const lines: string[] = [];
    const info = vi.spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    const error = vi.spyOn(console, "error").mockImplementation((line) => lines.push(String(line)));
    const lockedDb = {
      transaction: async (run: (tx: { execute: () => Promise<unknown> }) => Promise<unknown>) =>
        run({ execute: async () => [{ locked: false }] }),
    };
    expect(await runCallScoring(lockedDb as never)).toBeNull();
    const failingDb = {
      transaction: async () => {
        throw new Error("Failed query postgresql://app_worker:hunter2@db.example/isp");
      },
    };
    expect(await runCallScoring(failingDb as never)).toBeNull();
    const blob = lines.join("\n");
    expect(blob).toContain("overlap");
    expect(blob).toContain("worker.call_scoring_failed");
    expect(blob).not.toContain("hunter2");
    info.mockRestore();
    error.mockRestore();
  });

  it("logs a sanitized startup heartbeat success once", async () => {
    const rows: HeartbeatRow[] = [];
    const queue = {
      getJobCounts: async () => ({ wait: 1, active: 0, failed: 2 }),
    };
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line) => {
      lines.push(String(line));
    });
    await runWorkerHeartbeat(capturingHeartbeatDb(rows) as never, queue, { startup: true });
    await runWorkerHeartbeat(capturingHeartbeatDb(rows) as never, queue);
    const blob = lines.join("\n");
    expect(blob).toContain("worker.heartbeat_ok");
    expect(blob).toContain("queue_depth");
    expect(blob).toContain("failed_jobs");
    expect(blob.match(/worker\.heartbeat_ok/g)?.length).toBe(1);
    expect(rows[0]).toMatchObject({
      queueDepth: 1,
      failedJobs: 2,
      metadata: { queue_metrics_error_class: null },
    });
    spy.mockRestore();
  });

  it("persists null metrics on Redis timeout without blocking the heartbeat write", async () => {
    const rows: HeartbeatRow[] = [];
    const lines: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((line) => {
      lines.push(String(line));
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((line) => {
      lines.push(String(line));
    });
    const result = await runWorkerHeartbeat(
      capturingHeartbeatDb(rows) as never,
      { getJobCounts: () => new Promise(() => undefined) },
      { startup: true, timeoutMs: 20 },
    );
    expect(result.ok).toBe(true);
    expect(result.errorClass).toBe("timeout");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      queueDepth: null,
      failedJobs: null,
      metadata: { queue_metrics_error_class: "timeout" },
    });
    const blob = lines.join("\n");
    expect(blob).toContain("worker.queue_metrics_failed");
    expect(blob).toContain("worker.queue_metrics_unavailable");
    expect(blob).toContain("timeout");
    expect(blob).not.toContain("redis://");
    expect(blob).not.toContain("rediss://");
    expect(blob).not.toContain("password");
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("replaces null metrics with numeric values after a transient Redis recovery", async () => {
    const rows: HeartbeatRow[] = [];
    let calls = 0;
    const queue = {
      getJobCounts: async () => {
        calls += 1;
        if (calls === 1) {
          return new Promise<never>(() => undefined);
        }
        return { waiting: 0, active: 0, failed: 0 };
      },
    };
    await runWorkerHeartbeat(capturingHeartbeatDb(rows) as never, queue, { timeoutMs: 20 });
    await runWorkerHeartbeat(capturingHeartbeatDb(rows) as never, queue, { timeoutMs: 20 });
    expect(rows[0]).toMatchObject({
      queueDepth: null,
      failedJobs: null,
      metadata: { queue_metrics_error_class: "timeout" },
    });
    expect(rows[1]).toMatchObject({
      queueDepth: 0,
      failedJobs: 0,
      metadata: { queue_metrics_error_class: null },
    });
  });

  it("does not leak Redis credentials from a metrics failure", async () => {
    const rows: HeartbeatRow[] = [];
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line) => {
      lines.push(String(line));
    });
    await runWorkerHeartbeat(
      capturingHeartbeatDb(rows) as never,
      {
        getJobCounts: async () => {
          throw new Error("connect ECONNREFUSED rediss://default:s3cret-token@redis.example:6379");
        },
      },
      { startup: true },
    );
    const blob = lines.join("\n");
    expect(blob).toContain("worker.queue_metrics_failed");
    expect(blob).not.toContain("s3cret-token");
    expect(blob).not.toContain("rediss://");
    expect(rows[0]?.metadata?.queue_metrics_error_class).toBe("connection");
    spy.mockRestore();
  });

  it("reports shutting down as a 503-style health payload without secrets", () => {
    const payload = workerHealthPayload({
      status: "shutting_down",
      started_at: "2026-09-02T00:00:00.000Z",
      shutting_down: true,
      last_heartbeat_at: "2026-09-02T00:00:10.000Z",
      last_heartbeat_error_class: "permission_denied",
    });
    expect(payload.status).toBe("shutting_down");
    expect(payload.worker).toBe("shutting_down");
    expect(JSON.stringify(payload)).not.toMatch(/postgresql:\/\//);
  });
});

describe("startup redis transport probe", () => {
  it("runs once at worker startup and is not part of the heartbeat loop", () => {
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "worker.ts"), "utf8");
    expect(source).toMatch(/void runRedisTransportProbe\(\{ env, queue \}\)/);
    expect(source.match(/runRedisTransportProbe/g)?.length).toBe(2);
    const startWorker = source.slice(source.indexOf("export function startWorker"));
    const heartbeatLoop = startWorker.slice(
      startWorker.indexOf("const heartbeat = setInterval"),
      startWorker.indexOf("let providerSchedule"),
    );
    expect(heartbeatLoop).toContain("runWorkerHeartbeat(db, queue, { queueFailureSnapshot: failures.latest() })");
    expect(heartbeatLoop).not.toContain("runProviderSchedule");
    expect(heartbeatLoop).not.toContain("runRedisTransportProbe");
    expect(startWorker).toContain("startProviderScheduleLoop");
    expect(startWorker).toMatch(/onScheduleArm:[\s\S]*runProviderSchedule\(db, env\)/);
    expect(startWorker.indexOf("startProviderScheduleLoop")).toBeLessThan(startWorker.indexOf("void runRedisTransportProbe"));
    const heartbeat = source.slice(
      source.indexOf("export async function runWorkerHeartbeat"),
      source.indexOf("export async function runOutboxSweep"),
    );
    expect(heartbeat).not.toContain("runRedisTransportProbe");
  });
});

describe("provider runtime startup sync", () => {
  it("completes env reconciliation before the provider scheduler is armed", async () => {
    const order: string[] = [];
    const db = {
      transaction: async () => {
        order.push("reconcile");
        throw new Error("provider_runtime unavailable");
      },
    };
    const result = await startProviderScheduleLoop({
      db: db as never,
      env: { ISP_ENV: "staging" },
      onScheduleArm: () => {
        order.push("scheduler");
      },
    });
    expect(order).toEqual(["reconcile", "scheduler"]);
    expect(result.ok).toBe(false);
  });

  it("logs a sanitized reconciliation failure and keeps the worker operational", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line) => {
      lines.push(String(line));
    });
    const result = await reconcileProviderRuntimeFromEnv(
      {
        transaction: async () => {
          throw new Error("Failed query YOUTUBE_API_KEY=yt-secret-do-not-log");
        },
      } as never,
      { ISP_ENV: "staging", YOUTUBE_API_KEY: "yt-secret-do-not-log", PROVIDER_YOUTUBE_MODE: "live" },
    );
    expect(result.ok).toBe(false);
    expect(result.errorClass).toBeTruthy();
    const blob = lines.join("\n");
    expect(blob).toContain("worker.provider_runtime_sync_failed");
    expect(blob).toContain("provider_runtime_sync");
    expect(blob).not.toContain("yt-secret-do-not-log");
    expect(blob).not.toContain("YOUTUBE_API_KEY=");
    spy.mockRestore();
  });

  it("arms the scheduler after a failed reconcile so the worker stays up", async () => {
    let armed = false;
    const result = await startProviderScheduleLoop({
      db: {
        transaction: async () => {
          throw new Error("permission denied for table provider_runtime");
        },
      } as never,
      env: { ISP_ENV: "staging" },
      onScheduleArm: () => {
        armed = true;
      },
    });
    expect(result.ok).toBe(false);
    expect(armed).toBe(true);
  });
});

describe("TCG Card Central catalog import", () => {
  const live = {
    ISP_ENV: "staging",
    PROVIDER_TCG_CARD_CENTRAL_MODE: "live",
    TCC_API_BASE_URL: "https://tcc.example.test",
    TCC_API_TOKEN: "tcc-secret-do-not-log",
  };

  it("does nothing unless TCG Card Central is live with its URL and token", async () => {
    let transactions = 0;
    const db = {
      transaction: async () => {
        transactions += 1;
        throw new Error("unexpected");
      },
    };
    expect(await runTccCatalogImport(db as never, { ISP_ENV: "staging" })).toBeNull();
    expect(await runTccCatalogImport(db as never, { ...live, PROVIDER_TCG_CARD_CENTRAL_MODE: "fixture" })).toBeNull();
    expect(await runTccCatalogImport(db as never, { ...live, TCC_API_TOKEN: " " })).toBeNull();
    expect(await runTccCatalogImport(db as never, { ...live, TCC_API_BASE_URL: undefined })).toBeNull();
    expect(transactions).toBe(0);
  });

  it("imports before the provider scheduler (and its price collection) is armed", async () => {
    const lines: string[] = [];
    const info = vi.spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    const error = vi.spyOn(console, "error").mockImplementation((line) => lines.push(String(line)));
    const order: string[] = [];
    let requests = 0;
    const db = {
      transaction: async (run: (tx: { execute: () => Promise<unknown> }) => Promise<unknown>) => {
        order.push(order.includes("reconcile") ? "catalog" : "reconcile");
        if (order.length === 1) throw new Error("provider_runtime unavailable");
        // Another replica holds the catalog lock.
        return run({ execute: async () => [{ locked: false }] });
      },
    };
    await startProviderScheduleLoop({
      db: db as never,
      env: live,
      onScheduleArm: () => order.push("scheduler"),
      tccTransport: {
        fetch: async () => {
          requests += 1;
          return { status: 200, headers: {}, bodyText: "{}" };
        },
      },
    });
    expect(order).toEqual(["reconcile", "catalog", "scheduler"]);
    expect(requests).toBe(0);
    const blob = lines.join("\n");
    expect(blob).toContain("worker.tcc_catalog");
    expect(blob).toContain("overlap");
    expect(blob).not.toContain("tcc-secret-do-not-log");
    info.mockRestore();
    error.mockRestore();
  });

  it("logs a sanitized failure and keeps going", async () => {
    const lines: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((line) => lines.push(String(line)));
    const report = await runTccCatalogImport(
      {
        transaction: async () => {
          throw new Error("Failed query postgresql://app_worker:hunter2@db.example/isp");
        },
      } as never,
      live,
    );
    expect(report).toBeNull();
    const blob = lines.join("\n");
    expect(blob).toContain("worker.tcc_catalog_failed");
    expect(blob).not.toContain("hunter2");
    error.mockRestore();
  });
});
