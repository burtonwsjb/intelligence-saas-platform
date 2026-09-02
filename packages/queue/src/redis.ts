import { Redis } from "ioredis";
import { QueueUnavailableError } from "./errors.js";
import { requireRedisUrl } from "./env.js";
import { REDIS_COMMAND_TIMEOUT_MS } from "./names.js";
import { withDeadline } from "./recovery.js";

export function createRedisConnection(
  env: NodeJS.ProcessEnv = process.env,
  options?: { failFast?: boolean },
): Redis {
  const url = requireRedisUrl(env);
  const failFast = options?.failFast === true;
  const redis = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectTimeout: failFast ? 750 : 10_000,
    commandTimeout: failFast ? 750 : REDIS_COMMAND_TIMEOUT_MS,
    enableOfflineQueue: !failFast,
    retryStrategy: failFast ? () => null : (times) => Math.min(times * 200, 2_000),
    reconnectOnError: (error) => /readonly|loading/i.test(error.message),
    tls: url.startsWith("rediss://") ? {} : undefined,
  });
  redis.on("error", () => {
    // Callers map connection failures to QueueUnavailableError. Do not crash.
  });
  return redis;
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
  const redis = createRedisConnection(env, { failFast: true });
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
