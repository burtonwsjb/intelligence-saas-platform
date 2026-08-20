import { Redis } from "ioredis";
import { QueueUnavailableError } from "./errors.js";
import { requireRedisUrl } from "./env.js";

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
    enableOfflineQueue: !failFast,
    retryStrategy: failFast ? () => null : (times) => Math.min(times * 200, 2_000),
    tls: url.startsWith("rediss://") ? {} : undefined,
  });
  redis.on("error", () => {
    // Callers map connection failures to QueueUnavailableError. Do not crash.
  });
  return redis;
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
