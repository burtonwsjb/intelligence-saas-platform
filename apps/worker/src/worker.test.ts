import { describe, expect, it, vi } from "vitest";
import { MissingRedisUrlError } from "@isp/queue";
import {
  runProviderSchedule,
  runWorkerHeartbeat,
  startWorker,
} from "./worker.js";

describe("startWorker", () => {
  it("fails clearly when Redis is not configured", () => {
    expect(() => startWorker({ env: { NODE_ENV: "test" } })).toThrow(MissingRedisUrlError);
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
});
