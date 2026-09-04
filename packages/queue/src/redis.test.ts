import { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";
import { REDIS_COMMAND_TIMEOUT_MS } from "./names.js";
import { logQueueEvent } from "./logger.js";
import { createIngestQueue } from "./publisher.js";
import {
  assertBullmqConnection,
  createRedisConnection,
  createRedisConnectionOptions,
  isIoredisClient,
  resolveRedisClientRole,
  waitForRedisReady,
} from "./redis.js";

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

describe("BullMQ Redis URL handoff", () => {
  it("proves BullMQ merges localhost defaults onto a raw { url } options object", () => {
    const fromUrl = createRedisConnectionOptions(
      { REDIS_URL: "redis://user:hunter2@hosted.example:6380/2" },
      { role: "queue" },
    );
    const bullmqMerged = { port: 6379, host: "127.0.0.1", ...fromUrl };
    expect(fromUrl.url).toContain("hosted.example");
    expect(bullmqMerged.host).toBe("127.0.0.1");
    expect(bullmqMerged.port).toBe(6379);
    expect(bullmqMerged.url).toBe(fromUrl.url);
    expect(() => assertBullmqConnection(bullmqMerged)).toThrow(/raw \{ url \} options object/);
  });

  it("fails closed if createIngestQueue is given a raw { url } connection object", () => {
    expect(() =>
      createIngestQueue(
        { REDIS_URL: "redis://localhost:6379", QUEUE_PREFIX: "handoff" },
        {
          connection: createRedisConnectionOptions(
            { REDIS_URL: "redis://user:hunter2@hosted.example:6380/0" },
            { role: "queue" },
          ) as never,
        },
      ),
    ).toThrow(/raw \{ url \} options object/);
  });

  it("rejects handing a raw { url } options object to BullMQ", () => {
    expect(() => assertBullmqConnection({ url: "redis://hosted.example:6380/0" })).toThrow(
      /raw \{ url \} options object/,
    );
    const redis = createRedisConnection(
      { REDIS_URL: "redis://user:hunter2@hosted.example:6380/0" },
      { role: "queue" },
    );
    try {
      expect(() => assertBullmqConnection(redis)).not.toThrow();
      expect(isIoredisClient(redis)).toBe(true);
    } finally {
      redis.disconnect();
    }
  });

  it("uses the REDIS_URL host, TLS, and credentials on a real ioredis instance", () => {
    const redis = createRedisConnection(
      { REDIS_URL: "rediss://queueuser:hunter2@hosted.example:6380/2" },
      { role: "queue" },
    );
    try {
      expect(redis.options.host).toBe("hosted.example");
      expect(redis.options.port).toBe(6380);
      expect(redis.options.username).toBe("queueuser");
      expect(redis.options.password).toBe("hunter2");
      expect(redis.options.tls).toEqual({});
      const duplicate = redis.duplicate();
      try {
        expect(duplicate).not.toBe(redis);
        expect(duplicate.options.host).toBe("hosted.example");
        expect(duplicate.options.tls).toEqual({});
      } finally {
        duplicate.disconnect();
      }
    } finally {
      redis.disconnect();
    }
  });

  it("passes an ioredis instance into BullMQ so Queue keeps the intended host", async () => {
    const env = {
      REDIS_URL: "redis://queueuser:hunter2@hosted.example:6380/0",
      QUEUE_PREFIX: "handoff",
    };
    const queue = createIngestQueue(env);
    try {
      expect(isIoredisClient(queue.opts.connection)).toBe(true);
      expect(() => assertBullmqConnection(queue.opts.connection)).not.toThrow();
      const client = queue.opts.connection as Redis;
      expect(client.options.host).toBe("hosted.example");
      expect(client.options.port).toBe(6380);
      expect(client.options.username).toBe("queueuser");
      expect(client.options.password).toBe("hunter2");
      const leaked = JSON.stringify({
        host: client.options.host,
        tls: Boolean(client.options.tls),
      });
      expect(leaked).toContain("hosted.example");
      expect(leaked).not.toContain("hunter2");
    } finally {
      await queue.close();
    }
  });
});
