import { describe, expect, it } from "vitest";
import { observedJobType, queueFailureDetails, readQueueFailureSnapshot } from "./queue-failure.js";

const snapshot = () => ({
  version: "queue-failures.v1", status: "inspected", sampledAt: "2026-09-07T03:00:00.000Z",
  retainedCountAtRead: 2, sampleLimit: 100, sampledJobs: 2, truncated: false, errorClass: null,
  groups: [{ jobType: "provider.sync.v1", errorClass: "query_failed", queryTable: "discovery_topic", count: 2,
    earliestFinishedAt: null, latestFinishedAt: "2026-09-06T23:00:00.000Z", maxAttemptsMade: 5 }],
});
describe("secret-safe queue failure diagnostics", () => {
  it("classifies the underlying SQL code through wrapper errors", () => {
    const error = new Error('Failed query: select * from "discovery_topic"; params: PRIVATE_VALUE', {
      cause: Object.assign(new Error('relation "discovery_topic" does not exist'), { code: "42P01" }),
    });
    expect(queueFailureDetails(error)).toEqual({ errorClass: "undefined_table", queryTable: "discovery_topic" });
    expect(JSON.stringify(queueFailureDetails(error))).not.toContain("PRIVATE_VALUE");
  });
  it("does not invent the cause from a retained failed-query wrapper", () => {
    expect(queueFailureDetails('Failed query: select * from "discovery_topic"; params: SECRET'))
      .toEqual({ errorClass: "query_failed", queryTable: "discovery_topic" });
  });
  it("never includes credentials, arbitrary object names or job names in diagnostic output", () => {
    const text = 'Failed query: select * from "secret_table"; rediss://default:PASSWORD@host/?token=TOKEN';
    expect(queueFailureDetails(text)).toEqual({ errorClass: "query_failed", queryTable: null });
    expect(observedJobType(text)).toBe("other");
    expect(queueFailureDetails(Object.assign(new Error(text), { code: "API_TOKEN" })).errorClass).toBe("query_failed");
  });
  it("bounds cyclic cause chains and classifies fixed failure cases", () => {
    const cyclic: { cause?: unknown } = {}; cyclic.cause = cyclic;
    expect(queueFailureDetails(cyclic).errorClass).toBe("unknown");
    for (const [message, expected] of [["job_timeout", "timeout"], ["overlap", "overlap"],
      ["budget_exhausted", "budget_exhausted"], ['permission denied for table discovery_run', "permission_denied"],
      ['column "next_monitor_at" does not exist', "undefined_column"], ["unrelated unknown", "unknown"]]) {
      expect(queueFailureDetails(message).errorClass).toBe(expected);
    }
  });
  it("reconstructs trusted fields instead of exposing arbitrary metadata", () => {
    const value = snapshot();
    expect(readQueueFailureSnapshot({ ...value, secret: "DO_NOT_LOG" })).toEqual(value);
    value.groups[0] = { ...value.groups[0]!, secret: "DO_NOT_LOG" } as typeof value.groups[number];
    expect(JSON.stringify(readQueueFailureSnapshot(value))).not.toContain("DO_NOT_LOG");
  });
  it("rejects invalid states, counts, timestamps, object labels and unbounded groups", () => {
    expect(readQueueFailureSnapshot(null)).toBeNull();
    expect(readQueueFailureSnapshot({ ...snapshot(), status: "secret" })).toBeNull();
    expect(readQueueFailureSnapshot({ ...snapshot(), sampledAt: "DO_NOT_LOG" })).toBeNull();
    expect(readQueueFailureSnapshot({ ...snapshot(), sampleLimit: 101 })).toBeNull();
    expect(readQueueFailureSnapshot({ ...snapshot(), sampledJobs: 1 })).toBeNull();
    expect(readQueueFailureSnapshot({ ...snapshot(), retainedCountAtRead: -1 })).toBeNull();
    const value = snapshot(); value.groups[0]!.queryTable = "arbitrary_SECRET";
    expect(readQueueFailureSnapshot(value)).toBeNull();
  });
});
