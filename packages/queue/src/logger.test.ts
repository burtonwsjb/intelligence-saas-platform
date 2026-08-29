import { describe, expect, it, vi } from "vitest";
import { logQueueEvent, safeLoopErrorFields } from "./logger.js";

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

  it("classifies loop errors without leaking connection strings", () => {
    const error = Object.assign(new Error("Failed query postgresql://app_worker:hunter2@db/isp"), {
      cause: Object.assign(new Error("permission denied for table worker_heartbeat"), { code: "42501" }),
    });
    expect(safeLoopErrorFields(error)).toEqual({
      error_name: "Error",
      error_class: "permission_denied",
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logQueueEvent("error", "worker.heartbeat_failed", {
      operation: "worker_heartbeat",
      ...safeLoopErrorFields(error),
      retry: "next_cycle",
      token: "TCC_SECRET",
    });
    const line = String(spy.mock.calls[0]?.[0] ?? "");
    expect(line).toContain("worker.heartbeat_failed");
    expect(line).toContain("permission_denied");
    expect(line).not.toContain("hunter2");
    expect(line).not.toContain("postgresql://");
    expect(line).not.toContain("TCC_SECRET");
    spy.mockRestore();
  });
});
