export const MAX_OUTBOX_PUBLISH_ATTEMPTS = 20;
export const OUTBOX_RETRY_BACKOFF_MS = 5_000;
export const DATABASE_RETRY_ATTEMPTS = 3;
export const DATABASE_RETRY_BASE_MS = 200;

export const DATABASE_ERROR_CLASSES = [
  "transient",
  "timeout",
  "aborted",
  "connection",
  "permission",
  "constraint",
  "permanent",
  "unknown",
] as const;

export type DatabaseErrorClass = (typeof DATABASE_ERROR_CLASSES)[number];

export type ClassifiedDatabaseError = {
  errorClass: DatabaseErrorClass;
  retryable: boolean;
  code: string | null;
};

const TRANSIENT_CODES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "53300", // too_many_connections
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "08000",
  "08003",
  "08006",
  "08001",
  "08004",
  "08007",
]);

const TIMEOUT_CODES = new Set(["57014", "55P03"]);
const ABORTED_CODES = new Set(["25P02"]);
const PERMISSION_CODES = new Set(["42501", "42502", "42503"]);
const CONSTRAINT_CODES = new Set(["23502", "23503", "23505", "23514", "23P01"]);

const TRANSIENT_MESSAGE =
  /connection (terminated|reset|refused|closed)|econnreset|econnrefused|etimedout|enotfound|socket hang up|compute is not active|server closed the connection|too many clients|remaining connection slots|neon.*unavailable|the database system is (starting|shutting)/i;

function readCode(value: unknown): string | null {
  if (value && typeof value === "object" && "code" in value && typeof value.code === "string") {
    return value.code;
  }
  return null;
}

function readMessage(value: unknown): string {
  if (value instanceof Error) {
    return `${value.message} ${value.name} ${readMessage(value.cause)}`;
  }
  if (typeof value === "string") {
    return value;
  }
  return "";
}

export function classifyDatabaseError(error: unknown): ClassifiedDatabaseError {
  const code = readCode(error) ?? readCode(error instanceof Error ? error.cause : undefined);
  const message = readMessage(error);

  if (code && ABORTED_CODES.has(code)) {
    return { errorClass: "aborted", retryable: true, code };
  }
  if (code && TIMEOUT_CODES.has(code)) {
    return { errorClass: "timeout", retryable: true, code };
  }
  if (code && TRANSIENT_CODES.has(code)) {
    return { errorClass: "transient", retryable: true, code };
  }
  if (code && PERMISSION_CODES.has(code)) {
    return { errorClass: "permission", retryable: false, code };
  }
  if (code && CONSTRAINT_CODES.has(code)) {
    return { errorClass: "constraint", retryable: false, code };
  }
  if (TRANSIENT_MESSAGE.test(message)) {
    const errorClass = /etimedout|timeout|57014/i.test(message) ? "timeout" : "connection";
    return { errorClass, retryable: true, code };
  }
  if (code) {
    return { errorClass: "permanent", retryable: false, code };
  }
  return { errorClass: "unknown", retryable: false, code: null };
}

export function isTransientDatabaseError(error: unknown): boolean {
  return classifyDatabaseError(error).retryable;
}

export function classifyOutboxDelivery(attemptsAfterFailure: number): "retry" | "dead_letter" {
  return attemptsAfterFailure >= MAX_OUTBOX_PUBLISH_ATTEMPTS ? "dead_letter" : "retry";
}

export function outboxRetryAt(now = new Date(), backoffMs = OUTBOX_RETRY_BACKOFF_MS): Date {
  return new Date(now.getTime() + backoffMs);
}

export async function withDatabaseRetry<T>(
  operation: () => Promise<T>,
  options?: { attempts?: number; baseMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  const attempts = options?.attempts ?? DATABASE_RETRY_ATTEMPTS;
  const baseMs = options?.baseMs ?? DATABASE_RETRY_BASE_MS;
  const sleep = options?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const classified = classifyDatabaseError(error);
      if (!classified.retryable || attempt >= attempts) {
        throw error;
      }
      await sleep(Math.min(baseMs * 2 ** (attempt - 1), 2_000));
    }
  }
  throw lastError;
}
