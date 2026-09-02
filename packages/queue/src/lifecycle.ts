import { UnrecoverableJobError } from "./errors.js";
import {
  DEFAULT_BACKOFF_MS,
  DEFAULT_JOB_ATTEMPTS,
  JOB_LOCK_DURATION_MS,
  JOB_MAX_STALLED_COUNT,
  JOB_STALLED_INTERVAL_MS,
  JOB_TIMEOUT_MS,
  WORKER_SHUTDOWN_DRAIN_MS,
  WORKER_SHUTDOWN_FORCE_MS,
} from "./names.js";

export type JobFailureKind = "unrecoverable" | "timeout" | "stalled" | "transient" | "unknown";

export function classifyJobFailure(error: unknown): {
  kind: JobFailureKind;
  retryable: boolean;
} {
  if (error instanceof UnrecoverableJobError) {
    return { kind: "unrecoverable", retryable: false };
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/job_timeout|lock mismatch|lock expired/i.test(message)) {
    return { kind: "timeout", retryable: true };
  }
  if (/stalled/i.test(message)) {
    return { kind: "stalled", retryable: true };
  }
  if (error instanceof Error) {
    return { kind: "transient", retryable: true };
  }
  return { kind: "unknown", retryable: true };
}

export function defaultIngestJobOptions() {
  return {
    attempts: DEFAULT_JOB_ATTEMPTS,
    backoff: { type: "exponential" as const, delay: DEFAULT_BACKOFF_MS },
    removeOnComplete: 100,
    removeOnFail: false,
  };
}

export function defaultWorkerRuntimeOptions() {
  return {
    concurrency: 4,
    lockDuration: JOB_LOCK_DURATION_MS,
    stalledInterval: JOB_STALLED_INTERVAL_MS,
    maxStalledCount: JOB_MAX_STALLED_COUNT,
  };
}

export async function runGracefulStop(
  steps: Array<{ name: string; run: () => Promise<void> }>,
  options?: { timeoutMs?: number; now?: () => number },
): Promise<{ completed: string[]; timedOut: boolean; failedStep: string | null }> {
  const timeoutMs = options?.timeoutMs ?? WORKER_SHUTDOWN_DRAIN_MS;
  const started = (options?.now ?? Date.now)();
  const completed: string[] = [];
  for (const step of steps) {
    const remaining = timeoutMs - ((options?.now ?? Date.now)() - started);
    if (remaining <= 0) {
      return { completed, timedOut: true, failedStep: step.name };
    }
    try {
      await Promise.race([
        step.run(),
        new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error("shutdown_step_timeout")), remaining);
        }),
      ]);
      completed.push(step.name);
    } catch {
      return { completed, timedOut: true, failedStep: step.name };
    }
  }
  return { completed, timedOut: false, failedStep: null };
}

export function createShutdownLatch(options?: {
  forceExitMs?: number;
  exit?: (code: number) => void;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
}) {
  let shuttingDown = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const exit = options?.exit ?? ((code: number) => process.exit(code));
  const setTimer = options?.setTimer ?? setTimeout;
  const clearTimer = options?.clearTimer ?? clearTimeout;
  const forceExitMs = options?.forceExitMs ?? WORKER_SHUTDOWN_FORCE_MS;

  return {
    isShuttingDown: () => shuttingDown,
    async request(stop: () => Promise<void>): Promise<void> {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      forceTimer = setTimer(() => exit(1), forceExitMs);
      try {
        await stop();
        if (forceTimer) {
          clearTimer(forceTimer);
        }
        exit(0);
      } catch {
        if (forceTimer) {
          clearTimer(forceTimer);
        }
        exit(1);
      }
    },
  };
}

export { JOB_TIMEOUT_MS, WORKER_SHUTDOWN_DRAIN_MS, WORKER_SHUTDOWN_FORCE_MS };
