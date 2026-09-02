import { queueEnvironmentName } from "./env.js";

export const JOB_TYPES = [
  "source_event.normalize",
  "tcg.market.normalize.v1",
  "source.intelligence.normalize.v1",
  "provider.sync.v1",
  "creator.extract.v1",
  "intelligence.recompute.v1",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const DEFAULT_JOB_ATTEMPTS = 5;
export const DEFAULT_BACKOFF_MS = 2_000;
export const JOB_LOCK_DURATION_MS = 120_000;
export const JOB_STALLED_INTERVAL_MS = 30_000;
export const JOB_MAX_STALLED_COUNT = 2;
export const JOB_TIMEOUT_MS = 90_000;
export const WORKER_SHUTDOWN_DRAIN_MS = 20_000;
export const WORKER_SHUTDOWN_FORCE_MS = 25_000;
export const REDIS_COMMAND_TIMEOUT_MS = 5_000;

export function ingestQueueName(env: NodeJS.ProcessEnv = process.env): string {
  return `isp-${queueEnvironmentName(env)}-ingest`;
}

export function isKnownJobType(value: string): value is JobType {
  return (JOB_TYPES as readonly string[]).includes(value);
}
