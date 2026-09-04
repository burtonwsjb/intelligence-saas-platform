import { describe, expect, it } from "vitest";
import { REDIS_COMMAND_TIMEOUT_MS } from "./names.js";
import {
  createRedisConnection,
  createRedisConnectionOptions,
  resolveRedisClientRole,
  waitForRedisReady,
} from "./redis.js";
import { logQueueEvent } from "./logger.js";
import { vi } from "vitest";

describe("redis client roles", () => {
  it("keeps worker clients blocking-safe and queue clients fail-bounded", () => {
    const worker = createRedisConnectionOptions(
      { REDIS_URL: "rediss://user:hunter2@example.invalid:6379/0" },
      { role: "worker" },
    );
    const queue = createRedisConnectionOptions(
      { REDIS_URL: "rediss://user:hunter2@example.invalid:6379/0" },
      { role: "queue" },
    );
    expect(resolveRedisClientRole({ role: "worker" })).toBe("worker");
    expect(worker.maxRetriesPerRequest).toBeNull();
    expect(worker.commandTimeout).toBeUndefined();
    expect(worker.enableReadyCheck).toBe(false);
    expect(worker.family).toBe(0);
    expect(worker.tls).toEqual({});
    expect(queue.maxRetriesPerRequest).toBe(2);
    expect(queue.commandTimeout).toBe(REDIS_COMMAND_TIMEOUT_MS);
    expect(queue.enableReadyCheck).toBe(false);
    expect(queue.family).toBe(0);
    expect(queue.tls).toEqual({});
  });

  it("does not share option objects between worker and queue roles", () => {
    const env = { REDIS_URL: "redis://user:hunter2@example.invalid:6379/0" };
    const worker = createRedisConnectionOptions(env, { role: "worker" });
    const queue = createRedisConnectionOptions(env, { role: "queue" });
    expect(worker).not.toBe(queue);
    expect(worker.maxRetriesPerRequest).not.toBe(queue.maxRetriesPerRequest);
  });

  it("keeps fail-fast command timeouts without changing credential handling", () => {
    const redis = createRedisConnection(
      { REDIS_URL: "redis://user:hunter2@example.invalid:6379/0" },
      { role: "failFast" },
    );
    try {
      expect(redis.options.commandTimeout).toBe(750);
      expect(redis.options.enableOfflineQueue).toBe(false);
      expect(redis.options.enableReadyCheck).toBe(false);
      expect(redis.options.maxRetriesPerRequest).toBe(1);
      expect(redis.options.family).toBe(0);
    } finally {
      redis.disconnect();
    }
  });

  it("does not leak Redis credentials from connection diagnostics", () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line) => {
      lines.push(String(line));
    });
    const options = createRedisConnectionOptions(
      { REDIS_URL: "rediss://default:s3cret-token@redis.example:6379/0" },
      { role: "queue" },
    );
    logQueueEvent("info", "worker.redis_client_ready", {
      role: "queue",
      family: options.family ?? 0,
      enable_ready_check: options.enableReadyCheck === true,
      redis: options.url,
    });
    const blob = lines.join("\n");
    expect(blob).toContain("worker.redis_client_ready");
    expect(blob).not.toContain("s3cret-token");
    expect(blob).not.toContain("rediss://");
    spy.mockRestore();
  });

  it("fails safe when a metrics client never becomes ready", async () => {
    const redis = createRedisConnection(
      { REDIS_URL: "redis://127.0.0.1:59998" },
      { role: "failFast" },
    );
    try {
      await expect(waitForRedisReady(redis, 80)).rejects.toThrow(
        /redis_ready_timeout|redis_connection_closed/,
      );
    } finally {
      redis.disconnect();
    }
  });
});
