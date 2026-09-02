import { describe, expect, it, vi } from "vitest";
import {
  classifyDatabaseError,
  classifyOutboxDelivery,
  isTransientDatabaseError,
  MAX_OUTBOX_PUBLISH_ATTEMPTS,
  outboxRetryAt,
  withDatabaseRetry,
} from "./recovery.js";

describe("classifyDatabaseError", () => {
  it("classifies Neon/Postgres interruption, abort, timeout, and permission failures", () => {
    expect(classifyDatabaseError(Object.assign(new Error("server closed the connection unexpectedly"), { code: "57P01" }))).toEqual({
      errorClass: "transient",
      retryable: true,
      code: "57P01",
    });
    expect(classifyDatabaseError(Object.assign(new Error("current transaction is aborted"), { code: "25P02" })).errorClass).toBe(
      "aborted",
    );
    expect(classifyDatabaseError(Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }))).toMatchObject({
      errorClass: "timeout",
      retryable: true,
    });
    expect(
      classifyDatabaseError(
        Object.assign(new Error("Failed query postgresql://app_worker:hunter2@db.example/isp"), {
          cause: Object.assign(new Error("permission denied"), { code: "42501" }),
        }),
      ),
    ).toEqual({ errorClass: "permission", retryable: false, code: "42501" });
    expect(classifyDatabaseError(new Error("compute is not active"))).toMatchObject({
      errorClass: "connection",
      retryable: true,
    });
    expect(classifyDatabaseError(new Error("ECONNRESET"))).toMatchObject({ retryable: true });
    expect(isTransientDatabaseError(new Error("ETIMEDOUT"))).toBe(true);
    expect(classifyDatabaseError(Object.assign(new Error("duplicate key"), { code: "23505" })).retryable).toBe(false);
  });
});

describe("outbox delivery policy", () => {
  it("retries until the dead-letter threshold then fails permanently", () => {
    expect(classifyOutboxDelivery(1)).toBe("retry");
    expect(classifyOutboxDelivery(MAX_OUTBOX_PUBLISH_ATTEMPTS - 1)).toBe("retry");
    expect(classifyOutboxDelivery(MAX_OUTBOX_PUBLISH_ATTEMPTS)).toBe("dead_letter");
    expect(outboxRetryAt(new Date("2026-09-02T00:00:00.000Z")).toISOString()).toBe("2026-09-02T00:00:05.000Z");
  });
});

describe("withDatabaseRetry", () => {
  it("retries only classified transient errors and then succeeds", async () => {
    const sleep = vi.fn(async () => undefined);
    let calls = 0;
    const result = await withDatabaseRetry(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw Object.assign(new Error("connection terminated"), { code: "08006" });
        }
        return "ok";
      },
      { sleep },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry permission errors", async () => {
    await expect(
      withDatabaseRetry(async () => {
        throw Object.assign(new Error("permission denied"), { code: "42501" });
      }),
    ).rejects.toThrow("permission denied");
  });
});
