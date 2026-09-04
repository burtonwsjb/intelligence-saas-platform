import { describe, expect, it } from "vitest";
import { readQueueJobCounts } from "./counts.js";

describe("readQueueJobCounts", () => {
  it("treats an empty queue as 0 / 0", () => {
    expect(readQueueJobCounts({ wait: 0, active: 0, failed: 0 })).toEqual({
      queueDepth: 0,
      failedJobs: 0,
    });
    expect(readQueueJobCounts({ waiting: 0, active: 0, failed: 0 })).toEqual({
      queueDepth: 0,
      failedJobs: 0,
    });
  });

  it("sums waiting and active jobs without double-counting wait aliases", () => {
    expect(readQueueJobCounts({ wait: 2, active: 1, failed: 0 })).toEqual({
      queueDepth: 3,
      failedJobs: 0,
    });
    expect(readQueueJobCounts({ waiting: 4, active: 2, failed: 0 })).toEqual({
      queueDepth: 6,
      failedJobs: 0,
    });
    expect(readQueueJobCounts({ wait: 2, waiting: 2, active: 1, failed: 0 })).toEqual({
      queueDepth: 3,
      failedJobs: 0,
    });
  });

  it("reads failed jobs from either an explicit count or a missing key", () => {
    expect(readQueueJobCounts({ wait: 0, active: 0, failed: 7 })).toEqual({
      queueDepth: 0,
      failedJobs: 7,
    });
    expect(readQueueJobCounts({})).toEqual({ queueDepth: 0, failedJobs: 0 });
  });
});
