import { describe, expect, it, vi } from "vitest";
import { logQueueEvent } from "./logger.js";

describe("queue logs", () => {
  it("does not print secrets or credentials", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logQueueEvent("info", "job.started", {
      organization_id: "org_a",
      job_id: "job_1",
      authorization: "Bearer isp_test_deadbeef_secret",
      redis: "redis://user:supersecret@localhost:6379",
      status: "processing",
    });
    const line = String(spy.mock.calls[0]?.[0] ?? "");
    expect(line).toContain("org_a");
    expect(line).not.toContain("isp_test_deadbeef_secret");
    expect(line).not.toContain("supersecret");
    spy.mockRestore();
  });
});
