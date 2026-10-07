import { describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import type { Database } from "@isp/db";

const settings = { enabled: true, mode: "free_only", interval_hours: 1, max_jobs: 60 };
vi.mock("@isp/db", () => ({ getWorkerResources: vi.fn(async () => ({ settings, runs: [] })) }));

const { createRedisConnection } = await import("./redis.js");
const {
  assertRedisPermission, redisIsPermitted, redisNeedsPermission, trackPermittedRedisConnection, withMeteredRedisPermission,
} = await import("./redis-permission.js");

const hosted = { ISP_ENV: "staging", REDIS_URL: "rediss://default:secret@example.upstash.io:6379" };
const db = {} as Database;
const soon = () => new Date(Date.now() + 60_000);

function fakeClient(): Redis & { disconnected: boolean } {
  const client = {
    disconnected: false,
    disconnect() { client.disconnected = true; },
    duplicate() { return fakeClient(); },
  };
  return client as unknown as Redis & { disconnected: boolean };
}

describe("hosted Redis permission", () => {
  it("leaves local development and CI Redis unrestricted", () => {
    expect(redisNeedsPermission({ REDIS_URL: "redis://localhost:6379" })).toBe(false);
    expect(redisNeedsPermission({ ISP_ENV: "test", REDIS_URL: "redis://redis.internal:6379" })).toBe(false);
    expect(redisNeedsPermission({ REDIS_URL: "redis://127.0.0.1:6379" })).toBe(false);
    expect(redisIsPermitted({ REDIS_URL: "redis://localhost:6379" })).toBe(true);
  });

  it("blocks hosted Redis before any socket opens", () => {
    expect(redisNeedsPermission(hosted)).toBe(true);
    expect(redisNeedsPermission({ ISP_ENV: "production", REDIS_URL: "redis://localhost:6379" })).toBe(true);
    expect(() => assertRedisPermission({ ...hosted })).toThrow("redis_blocked_free_only");
    expect(() => createRedisConnection({ ...hosted })).toThrow("redis_blocked_free_only");
  });

  it("refuses a metered window while the owner setting is free-only or disabled", async () => {
    settings.mode = "free_only";
    await expect(withMeteredRedisPermission(db, hosted, soon(), async () => "ran")).rejects.toThrow("redis_blocked_free_only");
    settings.mode = "metered_redis";
    settings.enabled = false;
    await expect(withMeteredRedisPermission(db, hosted, soon(), async () => "ran")).rejects.toThrow("redis_blocked_free_only");
    settings.enabled = true;
  });

  it("bounds a metered window to three minutes and revokes every tracked socket", async () => {
    settings.mode = "metered_redis";
    await expect(withMeteredRedisPermission(db, hosted, new Date(Date.now() + 600_000), async () => "ran"))
      .rejects.toThrow("invalid_redis_window");
    await expect(withMeteredRedisPermission(db, hosted, new Date(Date.now() - 1), async () => "ran"))
      .rejects.toThrow("invalid_redis_window");
    let leaked: NodeJS.ProcessEnv | undefined;
    const client = fakeClient();
    let duplicate: (Redis & { disconnected: boolean }) | undefined;
    const result = await withMeteredRedisPermission(db, hosted, soon(), async (permitted) => {
      leaked = permitted;
      expect(permitted).not.toBe(hosted);
      expect(redisIsPermitted(permitted)).toBe(true);
      expect(redisIsPermitted(hosted)).toBe(false); // the process environment never gains access
      trackPermittedRedisConnection(permitted, client);
      duplicate = client.duplicate() as Redis & { disconnected: boolean };
      return "ran";
    });
    expect(result).toBe("ran");
    expect(client.disconnected).toBe(true);
    expect(duplicate?.disconnected).toBe(true);
    expect(redisIsPermitted(leaked)).toBe(false);
    expect(() => client.duplicate()).toThrow("redis_blocked_free_only");
    settings.mode = "free_only";
  });
});
