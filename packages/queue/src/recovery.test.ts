import { describe, expect, it } from "vitest";
import { classifyRedisError, isTransientRedisError, withDeadline } from "./recovery.js";

describe("classifyRedisError", () => {
  it("classifies reconnectable outages and timeouts without treating auth failures as transient", () => {
    expect(classifyRedisError(new Error("ECONNRESET"))).toEqual({ errorClass: "connection", retryable: true });
    expect(classifyRedisError(new Error("Command timed out"))).toEqual({ errorClass: "timeout", retryable: true });
    expect(classifyRedisError(new Error("READONLY You can't write against a read only replica"))).toEqual({
      errorClass: "readonly",
      retryable: true,
    });
    expect(classifyRedisError(new Error("LOADING Redis is loading the dataset in memory"))).toEqual({
      errorClass: "loading",
      retryable: true,
    });
    expect(classifyRedisError(new Error("NOAUTH Authentication required"))).toEqual({
      errorClass: "permanent",
      retryable: false,
    });
    expect(isTransientRedisError(new Error("ETIMEDOUT"))).toBe(true);
  });
});

describe("withDeadline", () => {
  it("rejects hanging work instead of waiting forever", async () => {
    await expect(
      withDeadline(
        new Promise(() => undefined),
        20,
        "redis_timeout",
      ),
    ).rejects.toThrow("redis_timeout");
    await expect(withDeadline(Promise.resolve("ok"), 50)).resolves.toBe("ok");
  });
});
