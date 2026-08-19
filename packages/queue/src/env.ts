export class MissingRedisUrlError extends Error {
  constructor() {
    super("REDIS_URL is not set. Queue-dependent work cannot run.");
    this.name = "MissingRedisUrlError";
  }
}

export function requireRedisUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.REDIS_URL?.trim();
  if (!value) {
    throw new MissingRedisUrlError();
  }
  return value;
}

export function isMissingRedisUrlError(error: unknown): error is MissingRedisUrlError {
  return error instanceof MissingRedisUrlError;
}

export function queueEnvironmentName(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.QUEUE_PREFIX?.trim();
  if (explicit && /^[a-z0-9_-]{1,32}$/i.test(explicit)) {
    return explicit;
  }
  const nodeEnv = env.NODE_ENV?.trim() || "development";
  if (nodeEnv === "production") {
    return "production";
  }
  if (nodeEnv === "test") {
    return "test";
  }
  if (nodeEnv === "staging") {
    return "staging";
  }
  return "local";
}
