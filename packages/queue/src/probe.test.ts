import { describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IngestQueue } from "./publisher.js";
import {
  assertStagingRedisProbeAllowed,
  classifyRedisTransportError,
  formatRedisTransportProbeReport,
  logRedisTransportProbe,
  runRedisTransportProbe,
  StagingRedisProbeError,
} from "./probe.js";

type Listener = (...args: unknown[]) => void;

function mockRedis(options?: {
  status?: string;
  ping?: () => Promise<string>;
  emitErrorAfterMs?: number;
  error?: Error;
}): Redis {
  const listeners = new Map<string, Set<Listener>>();
  const on = (event: string, fn: Listener) => {
    const set = listeners.get(event) ?? new Set();
    const first = set.size === 0;
    set.add(fn);
    listeners.set(event, set);
    if (first && event === "error" && options?.error && options.emitErrorAfterMs != null) {
      setTimeout(() => {
        for (const listener of listeners.get("error") ?? []) {
          listener(options.error);
        }
      }, options.emitErrorAfterMs);
    }
    return redis;
  };
  const off = (event: string, fn: Listener) => {
    listeners.get(event)?.delete(fn);
    return redis;
  };
  const redis = {
    status: options?.status ?? "ready",
    options: { host: "hosted.example" },
    on,
    off,
    once: on,
    ping: options?.ping ?? (async () => "PONG"),
    duplicate: () => redis,
    disconnect: () => undefined,
  } as unknown as Redis;
  return redis;
}

function mockQueue(overrides?: {
  waitUntilReady?: () => Promise<void>;
  getJobCounts?: () => Promise<Record<string, number>>;
}): IngestQueue {
  return {
    opts: { connection: {} },
    waitUntilReady: overrides?.waitUntilReady ?? (async () => undefined),
    getJobCounts: overrides?.getJobCounts ?? (async () => ({ wait: 0, active: 0, failed: 0 })),
  } as unknown as IngestQueue;
}

describe("classifyRedisTransportError", () => {
  it("preserves DNS, TCP, auth, and TLS classes", () => {
    expect(classifyRedisTransportError(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }))).toBe(
      "ENOTFOUND",
    );
    expect(classifyRedisTransportError(Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" }))).toBe(
      "ENETUNREACH",
    );
    expect(classifyRedisTransportError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))).toBe(
      "ECONNREFUSED",
    );
    expect(classifyRedisTransportError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(
      "ECONNRESET",
    );
    expect(classifyRedisTransportError(Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }))).toBe(
      "ETIMEDOUT",
    );
    expect(classifyRedisTransportError(new Error("WRONGPASS invalid username-password pair"))).toBe("WRONGPASS");
    expect(classifyRedisTransportError(Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }))).toBe(
      "TLS",
    );
  });
});

describe("assertStagingRedisProbeAllowed", () => {
  it("refuses production and requires staging", () => {
    expect(() => assertStagingRedisProbeAllowed({ ISP_ENV: "production" })).toThrow(StagingRedisProbeError);
    expect(() => assertStagingRedisProbeAllowed({ NODE_ENV: "production" })).toThrow(StagingRedisProbeError);
    expect(() => assertStagingRedisProbeAllowed({ ISP_ENV: "local" })).toThrow(/ISP_ENV=staging/);
    expect(() => assertStagingRedisProbeAllowed({ ISP_ENV: "staging" })).not.toThrow();
  });
});

describe("runRedisTransportProbe", () => {
  const env = { REDIS_URL: "rediss://queueuser:hunter2@hosted.example:6380/0", QUEUE_PREFIX: "probe" };

  it("records connect, ping, BullMQ ready, and counts success", async () => {
    const report = await runRedisTransportProbe({
      env,
      connection: mockRedis({ status: "ready" }),
      queue: mockQueue(),
      stageTimeoutMs: 50,
    });
    expect(report.stages.map((stage) => [stage.stage, stage.status])).toEqual([
      ["connect", "ok"],
      ["ping", "ok"],
      ["queue_ready", "ok"],
      ["job_counts", "ok"],
    ]);
    expect(report.stages.every((stage) => stage.error_class === null)).toBe(true);
    expect(report.stages.every((stage) => stage.redis_client_status === "ready")).toBe(true);
  });

  it("classifies DNS failures without waiting for a later stage to rewrite them", async () => {
    const report = await runRedisTransportProbe({
      env,
      connection: mockRedis({
        status: "wait",
        ping: () => new Promise(() => undefined),
        emitErrorAfterMs: 5,
        error: Object.assign(new Error("getaddrinfo ENOTFOUND redis.internal"), { code: "ENOTFOUND" }),
      }),
      queue: mockQueue({
        waitUntilReady: () => new Promise(() => undefined),
        getJobCounts: () => new Promise(() => undefined),
      }),
      stageTimeoutMs: 40,
    });
    expect(report.stages[0]?.status).toBe("timeout");
    expect(report.stages[0]?.error_class).toBe("ENOTFOUND");
  });

  it("classifies authentication failures on PING", async () => {
    const report = await runRedisTransportProbe({
      env,
      connection: mockRedis({
        status: "ready",
        ping: async () => {
          throw Object.assign(new Error("WRONGPASS invalid username-password pair"), { name: "ReplyError" });
        },
      }),
      queue: mockQueue(),
      stageTimeoutMs: 50,
    });
    expect(report.stages[0]?.status).toBe("ok");
    expect(report.stages[1]).toMatchObject({
      stage: "ping",
      status: "failed",
      error_class: "WRONGPASS",
      error_name: "ReplyError",
    });
  });

  it("classifies TLS connection failures", async () => {
    const report = await runRedisTransportProbe({
      env,
      connection: mockRedis({
        status: "wait",
        ping: () => new Promise(() => undefined),
        emitErrorAfterMs: 5,
        error: Object.assign(new Error("write EPROTO tls handshake failure"), { code: "EPROTO" }),
      }),
      queue: mockQueue({
        waitUntilReady: () => new Promise(() => undefined),
        getJobCounts: () => new Promise(() => undefined),
      }),
      stageTimeoutMs: 40,
    });
    expect(report.stages[0]?.status).toBe("timeout");
    expect(report.stages[0]?.error_class).toBe("TLS");
  });

  it("keeps the latest underlying error when the deadline fires first", async () => {
    const report = await runRedisTransportProbe({
      env,
      connection: mockRedis({
        status: "connecting",
        ping: () => new Promise(() => undefined),
        emitErrorAfterMs: 8,
        error: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      }),
      queue: mockQueue({
        waitUntilReady: () => new Promise(() => undefined),
        getJobCounts: () => new Promise(() => undefined),
      }),
      stageTimeoutMs: 35,
    });
    expect(report.stages[0]?.status).toBe("timeout");
    expect(report.stages[0]?.error_class).toBe("ECONNREFUSED");
    expect(report.stages[0]?.error_name).toBe("Error");
  });

  it("does not leak Redis credentials, URLs, or hosts from probe output", async () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line) => {
      lines.push(String(line));
    });
    const error = vi.spyOn(console, "error").mockImplementation((line) => {
      lines.push(String(line));
    });
    const report = await runRedisTransportProbe({
      env: { REDIS_URL: "rediss://default:s3cret-token@redis.example:6379/0", QUEUE_PREFIX: "probe" },
      connection: mockRedis({
        status: "wait",
        ping: () => new Promise(() => undefined),
        emitErrorAfterMs: 5,
        error: new Error("connect ECONNREFUSED rediss://default:s3cret-token@redis.example:6379"),
      }),
      queue: mockQueue({
        waitUntilReady: () => new Promise(() => undefined),
        getJobCounts: () => new Promise(() => undefined),
      }),
      stageTimeoutMs: 40,
    });
    logRedisTransportProbe(report);
    const printed = `${formatRedisTransportProbeReport(report)}\n${lines.join("\n")}`;
    expect(printed).toContain("redis.transport_probe");
    expect(printed).toContain("ECONNREFUSED");
    expect(printed).not.toContain("s3cret-token");
    expect(printed).not.toContain("rediss://");
    expect(printed).not.toContain("redis.example");
    expect(printed).not.toContain("hosted.example");
    expect(printed).not.toContain("hunter2");
    log.mockRestore();
    error.mockRestore();
  });
});

describe("staging redis probe CLI", () => {
  it("is read-only, refuses production, and never prints REDIS_URL", () => {
    const cli = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "staging-redis-probe.ts"), "utf8");
    expect(cli).toMatch(/assertStagingRedisProbeAllowed/);
    expect(cli).toMatch(/runRedisTransportProbe/);
    expect(cli).toMatch(/formatRedisTransportProbeReport/);
    expect(cli).not.toMatch(/console\.(log|error).*REDIS_URL/);
    expect(cli).not.toMatch(/process\.env\.REDIS_URL/);
    expect(cli).not.toMatch(/\.add\(/);
    expect(cli).not.toMatch(/publishOutboxJob/);
  });
});
