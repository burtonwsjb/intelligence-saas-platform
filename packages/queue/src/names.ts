import { queueEnvironmentName } from "./env.js";

export const JOB_TYPES = ["source_event.normalize", "tcg.market.normalize.v1"] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const DEFAULT_JOB_ATTEMPTS = 5;
export const DEFAULT_BACKOFF_MS = 2_000;

export function ingestQueueName(env: NodeJS.ProcessEnv = process.env): string {
  return `isp-${queueEnvironmentName(env)}-ingest`;
}

export function isKnownJobType(value: string): value is JobType {
  return (JOB_TYPES as readonly string[]).includes(value);
}
