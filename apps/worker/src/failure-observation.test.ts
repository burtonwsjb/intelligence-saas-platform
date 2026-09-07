import { afterEach, describe, expect, it, vi } from "vitest";
import { createFailureObserver, FAILURE_SAMPLE_LIMIT, inspectRetainedFailures, recordTerminalPlatformFailure } from "./failure-observation.js";

const dbMocks = vi.hoisted(() => ({ mark: vi.fn(), scoped: vi.fn() }));
vi.mock("@isp/db", async (original) => ({ ...await original<typeof import("@isp/db")>(),
  markPlatformOutboxFailed: dbMocks.mark,
  withPlatformContext: dbMocks.scoped,
}));
afterEach(() => vi.clearAllMocks());
const now = () => new Date("2026-09-07T03:00:00.000Z");
const envelope = { job_version: 1, job_type: "provider.sync.v1", job_id: "test_failure", provider_key: "youtube", created_at: now().toISOString() };

describe("retained Redis failure inspection", () => {
  it("reads an empty queue without treating it as a failed read", async () => {
    const getFailed = vi.fn().mockResolvedValue([]);
    const snapshot = await inspectRetainedFailures({ getFailedCount: async () => 0, getFailed }, { now });
    expect(snapshot).toMatchObject({ status: "inspected", sampledJobs: 0, retainedCountAtRead: 0, truncated: false, groups: [] });
    expect(getFailed).toHaveBeenCalledWith(0, FAILURE_SAMPLE_LIMIT - 1);
  });
  it("groups classifications and times without reading payloads, retrying or removing", async () => {
    const retry = vi.fn(); const remove = vi.fn();
    const job = { name: "provider.sync.v1", failedReason: 'Failed query: select * from "discovery_topic" params: API_TOKEN',
      finishedOn: Date.parse("2026-09-06T23:00:00Z"), attemptsMade: 5, retry, remove,
      get data(): never { throw new Error("Payload must not be read"); },
    };
    const snapshot = await inspectRetainedFailures({ getFailedCount: async () => 2, getFailed: async () => [job, { ...jobWithoutData(job), finishedOn: Date.parse("2026-09-06T22:00:00Z") }] }, { now });
    expect(snapshot).toMatchObject({ status: "inspected", sampledJobs: 2, truncated: false,
      groups: [{ jobType: "provider.sync.v1", errorClass: "query_failed", queryTable: "discovery_topic", count: 2,
        earliestFinishedAt: "2026-09-06T22:00:00.000Z", latestFinishedAt: "2026-09-06T23:00:00.000Z", maxAttemptsMade: 5 }] });
    expect(JSON.stringify(snapshot)).not.toMatch(/API_TOKEN|params|Payload/);
    expect(retry).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  });
  it("labels a bounded partial sample honestly", async () => {
    const snapshot = await inspectRetainedFailures({ getFailedCount: async () => 200,
      getFailed: async () => Array.from({ length: 100 }, () => ({ name: "unknown", failedReason: "private value" })) }, { now });
    expect(snapshot).toMatchObject({ status: "inspected", sampledJobs: 100, retainedCountAtRead: 200, truncated: true });
    expect(snapshot.groups[0]).toMatchObject({ jobType: "other", errorClass: "unknown", count: 100 });
  });
  it("bounds a stalled Redis read and exposes only a safe error class", async () => {
    const snapshot = await inspectRetainedFailures({ getFailedCount: async () => 52, getFailed: () => new Promise(() => undefined) }, { timeoutMs: 10, now });
    expect(snapshot).toMatchObject({ status: "unavailable", sampledJobs: 0, retainedCountAtRead: null, errorClass: "timeout" });
  });
  it("allows only one inspection in flight", async () => {
    let resolve!: (jobs: []) => void;
    const getFailed = vi.fn(() => new Promise<[]>((done) => { resolve = done; }));
    const observer = createFailureObserver({ getFailedCount: async () => 0, getFailed });
    const first = observer.refresh(); const second = observer.refresh();
    expect(second).toBe(first); expect(getFailed).toHaveBeenCalledTimes(1);
    resolve([]); await first;
    expect(observer.latest()?.status).toBe("inspected");
  });
});
function jobWithoutData(job: { name: string; failedReason: string; finishedOn: number; attemptsMade: number }) {
  return { name: job.name, failedReason: job.failedReason, finishedOn: job.finishedOn, attemptsMade: job.attemptsMade };
}
describe("terminal platform failure reporting", () => {
  it("does not mark delayed, waiting, completed or active jobs failed", async () => {
    for (const state of ["delayed", "waiting", "completed", "active", "unknown"]) {
      expect(await recordTerminalPlatformFailure({} as never, { data: envelope, getState: async () => state }, new Error("failed"))).toBe(0);
    }
    expect(dbMocks.scoped).not.toHaveBeenCalled();
  });
  it("records an exhausted failure only after Redis confirms failed state", async () => {
    const db = {} as never;
    dbMocks.scoped.mockImplementation(async (_db, fn) => fn(db)); dbMocks.mark.mockResolvedValue(1);
    const error = new Error("query with SECRET", { cause: { code: "42P01" } });
    expect(await recordTerminalPlatformFailure(db, { data: envelope, getState: async () => "failed" }, error)).toBe(1);
    expect(dbMocks.mark).toHaveBeenCalledWith(db, "test_failure", "undefined_table", { onlyIfPublished: true });
  });
  it("does not mutate malformed jobs or pretend an unchanged record was updated", async () => {
    expect(await recordTerminalPlatformFailure({} as never, undefined, new Error())).toBe(0);
    expect(await recordTerminalPlatformFailure({} as never, { data: { secret: "PRIVATE" }, getState: async () => "failed" }, new Error())).toBe(0);
    dbMocks.scoped.mockImplementation(async (db, fn) => fn(db)); dbMocks.mark.mockResolvedValue(0);
    expect(await recordTerminalPlatformFailure({} as never, { data: envelope, getState: async () => "failed" }, new Error())).toBe(0);
  });
});
