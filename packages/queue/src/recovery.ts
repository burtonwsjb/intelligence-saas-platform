export const REDIS_ERROR_CLASSES = [
  "timeout",
  "connection",
  "readonly",
  "loading",
  "permanent",
  "unknown",
] as const;

export type RedisErrorClass = (typeof REDIS_ERROR_CLASSES)[number];

export type ClassifiedRedisError = {
  errorClass: RedisErrorClass;
  retryable: boolean;
};

const TRANSIENT_MESSAGE =
  /econnreset|econnrefused|etimedout|enotfound|socket hang up|connection is closed|stream isn't writeable|readonly|loading|clusterdown|tryagain|moved|ask|max number of clients/i;

export function classifyRedisError(error: unknown): ClassifiedRedisError {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? "");
  if (/etimedout|command timed out|queue_metrics_timeout|operation_timeout|timeout/i.test(message)) {
    return { errorClass: "timeout", retryable: true };
  }
  if (/readonly/i.test(message)) {
    return { errorClass: "readonly", retryable: true };
  }
  if (/loading/i.test(message)) {
    return { errorClass: "loading", retryable: true };
  }
  if (TRANSIENT_MESSAGE.test(message)) {
    return { errorClass: "connection", retryable: true };
  }
  if (/noauth|wrongpass|invalid password|noreply|protocol/i.test(message)) {
    return { errorClass: "permanent", retryable: false };
  }
  return { errorClass: "unknown", retryable: false };
}

export function isTransientRedisError(error: unknown): boolean {
  return classifyRedisError(error).retryable;
}

export async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  label = "operation_timeout",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
