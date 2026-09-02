import { describe, expect, it, vi } from "vitest";
import { UnrecoverableJobError } from "./errors.js";
import {
  classifyJobFailure,
  createShutdownLatch,
  defaultIngestJobOptions,
  defaultWorkerRuntimeOptions,
  runGracefulStop,
} from "./lifecycle.js";
import { DEFAULT_BACKOFF_MS, DEFAULT_JOB_ATTEMPTS, JOB_LOCK_DURATION_MS } from "./names.js";

describe("classifyJobFailure", () => {
  it("separates poison jobs from retryable timeouts and stalls", () => {
    expect(classifyJobFailure(new UnrecoverableJobError("unknown type"))).toEqual({
      kind: "unrecoverable",
      retryable: false,
    });
    expect(classifyJobFailure(new Error("job_timeout"))).toEqual({ kind: "timeout", retryable: true });
    expect(classifyJobFailure(new Error("job stalled more than allowable limit"))).toEqual({
      kind: "stalled",
      retryable: true,
    });
    expect(classifyJobFailure(new Error("ECONNRESET"))).toEqual({ kind: "transient", retryable: true });
  });
});

describe("queue durability defaults", () => {
  it("keeps exponential backoff, inspectable failures, and stalled-job recovery", () => {
    expect(defaultIngestJobOptions()).toEqual({
      attempts: DEFAULT_JOB_ATTEMPTS,
      backoff: { type: "exponential", delay: DEFAULT_BACKOFF_MS },
      removeOnComplete: 100,
      removeOnFail: false,
    });
    expect(defaultWorkerRuntimeOptions()).toMatchObject({
      lockDuration: JOB_LOCK_DURATION_MS,
      maxStalledCount: 2,
    });
  });
});

describe("runGracefulStop", () => {
  it("runs cleanup steps in order and stops when a step times out", async () => {
    const seen: string[] = [];
    const result = await runGracefulStop(
      [
        { name: "intervals", run: async () => { seen.push("intervals"); } },
        {
          name: "worker",
          run: async () => {
            seen.push("worker");
            await new Promise((resolve) => setTimeout(resolve, 30));
          },
        },
        { name: "redis", run: async () => { seen.push("redis"); } },
      ],
      { timeoutMs: 10 },
    );
    expect(seen).toEqual(["intervals", "worker"]);
    expect(result.completed).toEqual(["intervals"]);
    expect(result.timedOut).toBe(true);
    expect(result.failedStep).toBe("worker");
  });
});

describe("createShutdownLatch", () => {
  it("is idempotent and force-exits if stop hangs past the Railway window", async () => {
    const exits: number[] = [];
    const latch = createShutdownLatch({
      forceExitMs: 15,
      exit: (code) => {
        exits.push(code);
      },
    });
    const first = latch.request(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const second = latch.request(async () => {
      exits.push(99);
    });
    await Promise.all([first, second]);
    expect(latch.isShuttingDown()).toBe(true);
    expect(exits).toEqual([0]);
  });

  it("exits 1 when stop throws", async () => {
    const exits: number[] = [];
    const latch = createShutdownLatch({
      exit: (code) => {
        exits.push(code);
      },
    });
    await latch.request(async () => {
      throw new Error("db end failed");
    });
    expect(exits).toEqual([1]);
  });

  it("schedules a force-exit timer for hung drains", () => {
    const timers: Array<() => void> = [];
    const latch = createShutdownLatch({
      forceExitMs: 25_000,
      exit: vi.fn(),
      setTimer: (fn) => {
        timers.push(fn);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined,
    });
    void latch.request(async () => {
      await new Promise(() => undefined);
    });
    expect(timers).toHaveLength(1);
  });
});
