import { isProductionRuntime, parseIspEnv } from "@isp/shared";
import type { Redis } from "ioredis";
import { requireRedisUrl } from "./env.js";
import { logQueueEvent } from "./logger.js";
import { createIngestQueue, type IngestQueue } from "./publisher.js";
import { classifyRedisError, withDeadline } from "./recovery.js";
import { assertBullmqConnection, closeRedisConnection, createRedisConnection } from "./redis.js";

export const REDIS_TRANSPORT_PROBE_EVENT = "redis.transport_probe";
export const REDIS_TRANSPORT_STAGES = ["connect", "ping", "queue_ready", "job_counts"] as const;
export const REDIS_PROBE_STAGE_TIMEOUT_MS = 8_000;

export type RedisTransportStage = (typeof REDIS_TRANSPORT_STAGES)[number];
export type RedisTransportStageStatus = "ok" | "failed" | "timeout";

export type RedisTransportStageResult = {
  event: typeof REDIS_TRANSPORT_PROBE_EVENT;
  stage: RedisTransportStage;
  status: RedisTransportStageStatus;
  elapsed_ms: number;
  error_name: string | null;
  error_class: string | null;
  redis_client_status: string;
};

export type RedisTransportProbeReport = {
  stages: RedisTransportStageResult[];
};

const TRANSPORT_CODES = ["ENOTFOUND", "ENETUNREACH", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"] as const;
const TLS_CODES =
  /^(EPROTO|ERR_TLS|CERT_|UNABLE_TO_VERIFY|DEPTH_ZERO_SELF_SIGNED|ERR_SSL|ERR_OSSL)/i;
const TLS_MESSAGE = /\btls\b|\bssl\b|certificate|handshake|unable to verify|self signed/i;
const AUTH_MESSAGE = /wrongpass|noauth|invalid password|invalid username-password/i;
const CODE_IN_TEXT = /\b(ENOTFOUND|ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|WRONGPASS|NOAUTH)\b/i;
const ALLOWED_ERROR_CLASSES = new Set([
  ...TRANSPORT_CODES,
  "WRONGPASS",
  "TLS",
  "timeout",
  "connection",
  "readonly",
  "loading",
  "permanent",
  "unknown",
]);

export class StagingRedisProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StagingRedisProbeError";
  }
}

export function assertStagingRedisProbeAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (isProductionRuntime(env)) {
    throw new StagingRedisProbeError("Refusing to run the staging Redis probe in production.");
  }
  if (parseIspEnv(env) !== "staging") {
    throw new StagingRedisProbeError("ISP_ENV=staging is required.");
  }
}

function readErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  if (error instanceof Error && error.cause && typeof error.cause === "object" && error.cause) {
    return readErrorCode(error.cause);
  }
  return "";
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name} ${error.message} ${readErrorCode(error)}`;
  }
  return String(error ?? "");
}

export function classifyRedisTransportError(error: unknown): string {
  const code = readErrorCode(error);
  if ((TRANSPORT_CODES as readonly string[]).includes(code)) {
    return code;
  }
  if (TLS_CODES.test(code) || TLS_MESSAGE.test(errorText(error))) {
    return "TLS";
  }
  const fromText = errorText(error).match(CODE_IN_TEXT)?.[1]?.toUpperCase();
  if (fromText === "NOAUTH" || fromText === "WRONGPASS" || AUTH_MESSAGE.test(errorText(error))) {
    return "WRONGPASS";
  }
  if (fromText && (TRANSPORT_CODES as readonly string[]).includes(fromText)) {
    return fromText;
  }
  const classified = classifyRedisError(error).errorClass;
  return ALLOWED_ERROR_CLASSES.has(classified) ? classified : "unknown";
}

function safeErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  return name.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80) || "Error";
}

function attachErrorCapture(redis: Redis): { latest: () => unknown; detach: () => void } {
  let latest: unknown;
  const onError = (error: unknown) => {
    latest = error;
  };
  redis.on("error", onError);
  return {
    latest: () => latest,
    detach: () => {
      redis.off("error", onError);
    },
  };
}

function waitForClientReady(redis: Redis, latestError: () => unknown): Promise<void> {
  if (redis.status === "ready") {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const finish = (fn: () => void) => {
      redis.off("ready", onReady);
      redis.off("end", onEnd);
      fn();
    };
    const onReady = () => finish(resolve);
    const onEnd = () =>
      finish(() => reject(latestError() ?? new Error("redis_connection_closed")));
    redis.once("ready", onReady);
    redis.once("end", onEnd);
  });
}

async function runTimedStage(
  stage: RedisTransportStage,
  timeoutMs: number,
  redis: Redis,
  latestError: () => unknown,
  run: () => Promise<void>,
): Promise<RedisTransportStageResult> {
  const started = Date.now();
  try {
    await withDeadline(run(), timeoutMs, "redis_probe_timeout");
    return {
      event: REDIS_TRANSPORT_PROBE_EVENT,
      stage,
      status: "ok",
      elapsed_ms: Date.now() - started,
      error_name: null,
      error_class: null,
      redis_client_status: redis.status,
    };
  } catch (error) {
    const timedOut = error instanceof Error && error.message === "redis_probe_timeout";
    const captured = latestError();
    const source = timedOut && captured != null ? captured : error;
    return {
      event: REDIS_TRANSPORT_PROBE_EVENT,
      stage,
      status: timedOut ? "timeout" : "failed",
      elapsed_ms: Date.now() - started,
      error_name: safeErrorName(source),
      error_class: classifyRedisTransportError(source),
      redis_client_status: redis.status,
    };
  }
}

export function serializeRedisTransportStage(result: RedisTransportStageResult): string {
  return JSON.stringify({
    event: result.event,
    stage: result.stage,
    status: result.status,
    elapsed_ms: result.elapsed_ms,
    error_name: result.error_name,
    error_class: result.error_class,
    redis_client_status: result.redis_client_status,
  });
}

export function formatRedisTransportProbeReport(report: RedisTransportProbeReport): string {
  return report.stages.map(serializeRedisTransportStage).join("\n");
}

export function logRedisTransportProbe(report: RedisTransportProbeReport): void {
  for (const stage of report.stages) {
    logQueueEvent(stage.status === "ok" ? "info" : "error", stage.event, {
      stage: stage.stage,
      status: stage.status,
      elapsed_ms: stage.elapsed_ms,
      error_name: stage.error_name,
      error_class: stage.error_class,
      redis_client_status: stage.redis_client_status,
    });
  }
}

export async function runRedisTransportProbe(options?: {
  env?: NodeJS.ProcessEnv;
  queue?: IngestQueue;
  connection?: Redis;
  stageTimeoutMs?: number;
}): Promise<RedisTransportProbeReport> {
  const env = options?.env ?? process.env;
  requireRedisUrl(env);
  const timeoutMs = options?.stageTimeoutMs ?? REDIS_PROBE_STAGE_TIMEOUT_MS;
  let ownedConnection: Redis | undefined;
  let ownedQueue: IngestQueue | undefined;
  const connection =
    options?.connection ??
    (options?.queue?.opts.connection as Redis | undefined) ??
    (ownedConnection = createRedisConnection(env, { role: "queue" }));
  assertBullmqConnection(connection);
  const queue = options?.queue ?? (ownedQueue = createIngestQueue(env, { connection }));
  const capture = attachErrorCapture(connection);
  try {
    const stages: RedisTransportStageResult[] = [];
    stages.push(
      await runTimedStage("connect", timeoutMs, connection, capture.latest, () =>
        waitForClientReady(connection, capture.latest),
      ),
    );
    stages.push(
      await runTimedStage("ping", timeoutMs, connection, capture.latest, async () => {
        const pong = await connection.ping();
        if (pong !== "PONG") {
          throw new Error("redis_ping_failed");
        }
      }),
    );
    stages.push(
      await runTimedStage("queue_ready", timeoutMs, connection, capture.latest, async () => {
        await queue.waitUntilReady();
      }),
    );
    stages.push(
      await runTimedStage("job_counts", timeoutMs, connection, capture.latest, async () => {
        const counts = await queue.getJobCounts("wait", "active", "failed");
        if (
          typeof (counts.wait ?? counts.waiting ?? 0) !== "number" ||
          typeof (counts.active ?? 0) !== "number" ||
          typeof (counts.failed ?? 0) !== "number"
        ) {
          throw new Error("redis_job_counts_invalid");
        }
      }),
    );
    return { stages };
  } finally {
    capture.detach();
    if (ownedQueue) {
      await ownedQueue.close();
    }
    if (ownedConnection) {
      await closeRedisConnection(ownedConnection);
    }
  }
}
