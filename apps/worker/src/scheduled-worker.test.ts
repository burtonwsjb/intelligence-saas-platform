import { describe, expect, it, vi } from "vitest";
import type { ScheduledJob, ScheduledRun } from "@isp/db";
import { UnrecoverableJobError } from "@isp/queue";
import { executeScheduledCycle, type ScheduledCycleDeps } from "./scheduled-worker.js";

const inSlot = new Date("2026-03-10T15:01:00Z"); // 08:01 Phoenix
const quiet = new Date("2026-03-10T10:01:00Z"); // 03:01 Phoenix

function run(overrides: Partial<ScheduledRun> = {}): ScheduledRun {
  return {
    id: "run_1", mode: "free_only", status: "running", started_at: inSlot, deadline_at: new Date(inSlot.getTime() + 180_000),
    attempted: 0, processed: 0, failures: 0, max_jobs: 60, ...overrides,
  };
}
const jobId = (label: string) => `job_${label}_scheduled`;
const label = (id: string) => id.replace(/^job_|_scheduled$/g, "");
function tenantJob(name: string, attempt = 1, organization = "org_a"): ScheduledJob {
  return {
    kind: "tenant", job_id: jobId(name), organization_id: organization, attempt,
    payload: {
      job_version: 1, job_id: jobId(name), job_type: "source_event.normalize", organization_id: organization,
      source_event_id: `evt_${name}_scheduled`, created_at: inSlot.toISOString(),
    },
  };
}
function deps(jobs: ScheduledJob[], overrides: Partial<ScheduledCycleDeps> = {}) {
  const queue = [...jobs];
  const finished: [string, string, string | undefined][] = [];
  const result = {
    finished,
    runStatus: undefined as string | undefined,
    deps: {
      now: () => inSlot,
      stopping: () => false,
      claimRun: vi.fn(async () => run()),
      claimJob: vi.fn(async () => queue.shift() ?? null),
      process: vi.fn(async () => ({ status: "processed" })),
      finishJob: vi.fn(async (_run: string, job: ScheduledJob, state: string, error?: string) => {
        finished.push([label(job.job_id), state, error]);
      }),
      finishRun: vi.fn(async (_run: string, status: string) => { result.runStatus = status; }),
      prepare: vi.fn(async () => undefined),
      metered: vi.fn(async () => undefined),
      ...overrides,
    } satisfies ScheduledCycleDeps,
  };
  return result;
}

describe("scheduled free-only batch", () => {
  it("does nothing outside the Phoenix window or while stopping", async () => {
    const quietRun = deps([], { now: () => quiet });
    expect(await executeScheduledCycle(quietRun.deps)).toBe("outside_window");
    expect(quietRun.deps.claimRun).not.toHaveBeenCalled();
    const stopping = deps([], { stopping: () => true });
    expect(await executeScheduledCycle(stopping.deps)).toBe("outside_window");
  });

  it("reports when the database does not admit a batch", async () => {
    const t = deps([], { claimRun: vi.fn(async () => null) });
    expect(await executeScheduledCycle(t.deps)).toBe("not_admitted");
    expect(t.deps.prepare).not.toHaveBeenCalled();
    expect(t.deps.finishRun).not.toHaveBeenCalled();
  });

  it("drains claimed jobs through the canonical handler and closes the batch", async () => {
    const t = deps([tenantJob("a"), tenantJob("b")]);
    expect(await executeScheduledCycle(t.deps)).toBe("completed");
    expect(t.deps.prepare).toHaveBeenCalledOnce();
    expect(t.deps.process).toHaveBeenCalledTimes(2);
    expect(t.finished).toEqual([["a", "processed", undefined], ["b", "processed", undefined]]);
    expect(t.runStatus).toBe("completed");
  });

  it("fails a job whose envelope does not match its durable outbox scope", async () => {
    const forged = { ...tenantJob("x"), organization_id: "org_b" };
    const t = deps([forged, tenantJob("y")]);
    expect(await executeScheduledCycle(t.deps)).toBe("completed");
    expect(t.finished).toEqual([["x", "failed", "invalid_job_scope"], ["y", "processed", undefined]]);
    expect(t.deps.process).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures, and fails unrecoverable or exhausted ones", async () => {
    const process = vi.fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockRejectedValueOnce(new UnrecoverableJobError("bad"))
      .mockRejectedValueOnce(new Error("transient"));
    const t = deps([tenantJob("r"), tenantJob("u"), tenantJob("e", 3)], { process });
    expect(await executeScheduledCycle(t.deps)).toBe("completed");
    expect(t.finished).toEqual([
      ["r", "retry", "processing_failed"],
      ["u", "failed", "processing_failed"],
      ["e", "failed", "processing_failed"],
    ]);
  });

  it("stops at an uncertain timeout instead of overlapping or replaying work", async () => {
    const t = deps([tenantJob("slow"), tenantJob("next")], {
      process: vi.fn(() => new Promise<never>(() => undefined)),
      jobTimeoutMs: 5,
    });
    expect(await executeScheduledCycle(t.deps)).toBe("indeterminate");
    expect(t.finished).toEqual([["slow", "indeterminate", "processing_timeout"]]);
    expect(t.deps.claimJob).toHaveBeenCalledTimes(1);
    expect(t.runStatus).toBe("indeterminate");
  });

  it("stops claiming at the batch deadline", async () => {
    let clock = inSlot.getTime();
    const t = deps([tenantJob("a"), tenantJob("b")], {
      now: () => new Date(clock),
      process: vi.fn(async () => { clock += 200_000; return { status: "processed" }; }),
    });
    expect(await executeScheduledCycle(t.deps)).toBe("completed");
    expect(t.finished).toEqual([["a", "processed", undefined]]);
  });

  it("marks the batch for review when the database state becomes unknown", async () => {
    const t = deps([tenantJob("a")], { finishJob: vi.fn(async () => { throw new Error("connection_lost"); }) });
    expect(await executeScheduledCycle(t.deps)).toBe("indeterminate");
    expect(t.runStatus).toBe("indeterminate");
  });

  it("hands metered batches to the bounded Redis window without draining Postgres", async () => {
    const t = deps([tenantJob("a")], { claimRun: vi.fn(async () => run({ mode: "metered_redis" })) });
    expect(await executeScheduledCycle(t.deps)).toBe("completed");
    expect(t.deps.metered).toHaveBeenCalledOnce();
    expect(t.deps.claimJob).not.toHaveBeenCalled();
    expect(t.runStatus).toBe("completed");
  });
});
