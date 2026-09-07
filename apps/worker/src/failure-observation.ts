import { markPlatformOutboxFailed, withPlatformContext, type Database } from "@isp/db";
import { parseJobEnvelope, withDeadline } from "@isp/queue";
import { observedJobType, queueFailureDetails, type QueueFailureGroup, type QueueFailureSnapshot } from "@isp/shared";

export const FAILURE_SAMPLE_LIMIT = 100;
export const FAILURE_INSPECTION_INTERVAL_MS = 300_000;
type FailedJob = { name?: string; failedReason?: string; finishedOn?: number; attemptsMade?: number };
type InspectionQueue = { getFailedCount: () => Promise<number>; getFailed: (start: number, end: number) => Promise<FailedJob[]> };
const count = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
function time(value?: number): string | null {
  return typeof value === "number" && value >= 0 && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
}
/** Redis reads only. Never reads job.data, retries, removes or relabels a job. */
export async function inspectRetainedFailures(queue: InspectionQueue, options?: { timeoutMs?: number; now?: () => Date }): Promise<QueueFailureSnapshot> {
  const base = { version: "queue-failures.v1" as const, sampledAt: (options?.now?.() ?? new Date()).toISOString(), sampleLimit: FAILURE_SAMPLE_LIMIT };
  try {
    const [retained, entries] = await withDeadline(Promise.all([
      queue.getFailedCount(), queue.getFailed(0, FAILURE_SAMPLE_LIMIT - 1),
    ]), options?.timeoutMs ?? 5000, "queue_failure_inspection_timeout");
    if (!Number.isSafeInteger(retained) || retained < 0 || !Array.isArray(entries)) throw new Error("invalid_queue_inspection");
    const groups = new Map<string, QueueFailureGroup>();
    const jobs = entries.filter(Boolean).slice(0, FAILURE_SAMPLE_LIMIT);
    for (const job of jobs) {
      const jobType = observedJobType(job.name);
      const details = queueFailureDetails(job.failedReason);
      const key = JSON.stringify([jobType, details.errorClass, details.queryTable]);
      const at = time(job.finishedOn);
      const group = groups.get(key) ?? { jobType, ...details, count: 0, earliestFinishedAt: null, latestFinishedAt: null, maxAttemptsMade: 0 };
      group.count += 1;
      if (at && (!group.earliestFinishedAt || at < group.earliestFinishedAt)) group.earliestFinishedAt = at;
      if (at && (!group.latestFinishedAt || at > group.latestFinishedAt)) group.latestFinishedAt = at;
      group.maxAttemptsMade = Math.max(group.maxAttemptsMade, count(job.attemptsMade));
      groups.set(key, group);
    }
    return { ...base, status: "inspected", retainedCountAtRead: count(retained), sampledJobs: jobs.length,
      truncated: retained > jobs.length, errorClass: null, groups: [...groups.values()] };
  } catch (error) {
    return { ...base, status: "unavailable", retainedCountAtRead: null, sampledJobs: 0, truncated: false,
      errorClass: queueFailureDetails(error).errorClass, groups: [] };
  }
}
/** No overlap even when an inspection is slower than its scheduling interval. */
export function createFailureObserver(queue: InspectionQueue) {
  let pending: Promise<void> | undefined;
  let latest: QueueFailureSnapshot | null = null;
  return {
    latest: () => latest,
    refresh(): Promise<void> {
      if (pending) return pending;
      pending = inspectRetainedFailures(queue).then((snapshot) => { latest = snapshot; }).finally(() => { pending = undefined; });
      return pending;
    },
  };
}
/** Called by BullMQ's failed event. Delayed retries are NOT terminal failures.
 * This covers platform jobs only. It never retries/removes Redis jobs or changes
 * processed, already failed, or operator-requeued database records.
 */
export async function recordTerminalPlatformFailure(db: Database, job: {
  data: unknown; getState: () => Promise<string>;
} | undefined, error: unknown): Promise<number> {
  if (!job || await withDeadline(job.getState(), 5000, "queue_failure_state_timeout") !== "failed") return 0;
  let envelope;
  try { envelope = parseJobEnvelope(job.data); } catch { return 0; }
  if (envelope.job_type === "source_event.normalize") return 0;
  const { errorClass } = queueFailureDetails(error);
  return withPlatformContext(db, (tx) => markPlatformOutboxFailed(tx, envelope.job_id, errorClass, { onlyIfPublished: true }));
}
