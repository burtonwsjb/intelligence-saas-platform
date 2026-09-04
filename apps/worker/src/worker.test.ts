import { describe, expect, it, vi } from "vitest";
import { MissingRedisUrlError } from "@isp/queue";
import {
  collectQueueCounts,
  runProviderSchedule,
  runWorkerHeartbeat,
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
