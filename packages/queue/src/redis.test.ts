import { describe, expect, it } from "vitest";
import { createRedisConnection } from "./redis.js";

describe("createRedisConnection", () => {
  it("uses dual-stack family and omits commandTimeout on long-lived clients", () => {
    const redis = createRedisConnection({
      REDIS_URL: "rediss://user:hunter2@example.invalid:6379/0",
    });
    try {
      expect(redis.options.family).toBe(0);
      expect(redis.options.commandTimeout).toBeUndefined();
      expect(redis.options.tls).toEqual({});
      expect(redis.options.enableOfflineQueue).toBe(true);
    } finally {
      redis.disconnect();
    }
  });

  it("keeps fail-fast command timeouts without changing credential handling", () => {
    const redis = createRedisConnection(
      { REDIS_URL: "redis://user:hunter2@example.invalid:6379/0" },
      { failFast: true },
    );
    try {
      expect(redis.options.commandTimeout).toBe(750);
      expect(redis.options.enableOfflineQueue).toBe(false);
      expect(redis.options.family).toBe(0);
    } finally {
      redis.disconnect();
    }
  });
});
