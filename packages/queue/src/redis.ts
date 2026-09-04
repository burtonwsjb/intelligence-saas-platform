import { Redis, type RedisOptions } from "ioredis";
import { QueueUnavailableError } from "./errors.js";
import { requireRedisUrl } from "./env.js";
import { REDIS_COMMAND_TIMEOUT_MS } from "./names.js";
import { withDeadline } from "./recovery.js";

export type RedisClientRole = "worker" | "queue" | "failFast";

export type RedisConnectionOptions = RedisOptions & { url: string };

export function resolveRedisClientRole(options?: {
  failFast?: boolean;
  role?: RedisClientRole;
}): RedisClientRole {
  if (options?.role) {
    return options.role;
  }
  return options?.failFast === true ? "failFast" : "worker";
}

export function createRedisConnectionOptions(
  env: NodeJS.ProcessEnv = process.env,
  options?: { failFast?: boolean; role?: RedisClientRole },
): RedisConnectionOptions {
  const url = requireRedisUrl(env);
  const role = resolveRedisClientRole(options);
  const failFast = role === "failFast";
  const queueLike = role === "queue" || failFast;
  return {
    url,
    // Worker must use null so BullMQ blocking pops are not aborted.
    // Queue/metrics must use a finite value so getJobCounts cannot hang forever.
    maxRetriesPerRequest: failFast ? 1 : queueLike ? 2 : null,
    family: 0,
    // Hosted Redis often delays or never answers INFO. ioredis ready-check and
    // BullMQ getRedisVersion both call INFO; that hang is the staging timeout.
    enableReadyCheck: false,
    lazyConnect: false,
    connectTimeout: failFast ? 750 : 10_000,
    ...(queueLike ? { commandTimeout: failFast ? 750 : REDIS_COMMAND_TIMEOUT_MS } : {}),
    enableOfflineQueue: !failFast,
    retryStrategy: failFast ? () => null : (times) => Math.min(times * 200, 2_000),
    reconnectOnError: (error) => /readonly|loading/i.test(error.message),
    tls: url.startsWith("rediss://") ? {} : undefined,
  };
}

export function isIoredisClient(value: unknown): value is Redis {
  return Boolean(
    value &&
      typeof value === "object" &&
      "options" in value &&
      "status" in value &&
      typeof (value as Redis).duplicate === "function",
  );
}

export function assertBullmqConnection(connection: unknown): asserts connection is Redis {
  if (isIoredisClient(connection)) {
    return;
  }
  if (connection && typeof connection === "object" && "url" in connection) {
    throw new Error(
      "BullMQ connection cannot be a raw { url } options object; pass new Redis(url, options).",
    );
  }
  throw new Error("BullMQ connection must be an ioredis Redis instance.");
}

export function createRedisConnection(
  env: NodeJS.ProcessEnv = process.env,
  options?: { failFast?: boolean; role?: RedisClientRole },
): Redis {
  const { url, ...redisOptions } = createRedisConnectionOptions(env, options);
  const redis = new Redis(url, redisOptions);
  redis.on("error", () => {
    // Callers map connection failures to QueueUnavailableError. Do not crash.
  });
  return redis;
}

export async function waitForRedisReady(redis: Redis, timeoutMs = 5_000): Promise<void> {
  if (redis.status === "ready") {
    return;
  }
  await withDeadline(
    new Promise<void>((resolve, reject) => {
      if (redis.status === "ready") {
        resolve();
        return;
      }
      const onReady = () => resolve();
      const onEnd = () => reject(new Error("redis_connection_closed"));
      redis.once("ready", onReady);
      redis.once("end", onEnd);
    }),
    timeoutMs,
    "redis_ready_timeout",
  );
}

export async function closeRedisConnection(redis: Redis, timeoutMs = 3_000): Promise<void> {
  try {
    await withDeadline(redis.quit(), timeoutMs, "redis_quit_timeout");
  } catch {
    redis.disconnect();
  }
}

export async function assertRedisAvailable(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const redis = createRedisConnection(env, { role: "failFast" });
  try {
    const pong = await redis.ping();
    if (pong !== "PONG") {
      throw new QueueUnavailableError();
    }
  } catch (error) {
    if (error instanceof QueueUnavailableError) {
      throw error;
    }
    throw new QueueUnavailableError();
  } finally {
    redis.disconnect();
  }
}
