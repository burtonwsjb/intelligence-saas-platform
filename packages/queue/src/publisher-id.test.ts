import { describe, expect, it } from "vitest";
import { bullmqJobId } from "./publisher.js";
describe("BullMQ outbox identifier handoff", () => {
  it("handles colon-delimited source jobs without changing canonical IDs", () => {
    const id = "source.intelligence.normalize.v1:sin_example";
    expect(bullmqJobId(id)).toMatch(/^ispjob_[a-f0-9]{64}$/);
    expect(bullmqJobId(id)).not.toContain(":");
    expect(bullmqJobId(id)).toBe(bullmqJobId(id));
    expect(bullmqJobId(id)).not.toBe(bullmqJobId(id + "2"));
    expect(bullmqJobId("123")).not.toBe("123");
  });
});
