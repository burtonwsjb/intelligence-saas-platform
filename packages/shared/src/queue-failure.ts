/** This is a diagnostic classification, not authorization to retry a job. */
export const QUEUE_FAILURE_CLASSES = [
  "undefined_table", "undefined_column", "permission_denied", "authentication",
  "aborted_transaction", "not_null_violation", "check_violation", "unique_violation",
  "timeout", "connection", "stalled", "overlap", "budget_exhausted",
  "discovery_failed", "monitoring_failed", "query_failed", "invalid_envelope", "unknown",
] as const;
export type QueueFailureClass = (typeof QUEUE_FAILURE_CLASSES)[number];
export const QUEUE_OBSERVED_JOB_TYPES = [
  "provider.sync.v1", "source.intelligence.normalize.v1", "tcg.market.normalize.v1",
  "creator.extract.v1", "intelligence.recompute.v1", "source_event.normalize", "other",
] as const;
const TABLES = ["discovery_topic", "discovery_run", "discovered_creator", "discovery_request_budget", "discovery_creator_topic", "provider_runtime", "platform_outbox", "source_ingest", "source_content", "creator", "creator_call", "tcg_set", "tcg_printing", "tcg_score_snapshot"] as const;
const CODES: Record<string, QueueFailureClass> = {
  "42P01": "undefined_table", "42703": "undefined_column", "42501": "permission_denied",
  "28P01": "authentication", "25P02": "aborted_transaction", "23502": "not_null_violation",
  "23514": "check_violation", "23505": "unique_violation", "57014": "timeout",
  ETIMEDOUT: "timeout", ECONNREFUSED: "connection", ECONNRESET: "connection", ENOTFOUND: "connection",
};
const includes = (list: readonly string[], value: unknown): value is string => typeof value === "string" && list.includes(value);
export function observedJobType(value: unknown): (typeof QUEUE_OBSERVED_JOB_TYPES)[number] {
  return includes(QUEUE_OBSERVED_JOB_TYPES, value) ? value as (typeof QUEUE_OBSERVED_JOB_TYPES)[number] : "other";
}
export function queueFailureDetails(error: unknown): { errorClass: QueueFailureClass; queryTable: string | null } {
  const messages: string[] = [];
  const seen = new Set<object>();
  let current = error;
  let errorClass: QueueFailureClass | undefined;
  for (let i = 0; i < 6; i += 1) {
    if (typeof current === "string") { messages.push(current.slice(0, 8192)); break; }
    if (!current || typeof current !== "object" || seen.has(current)) break;
    seen.add(current);
    const entry = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof entry.code === "string" && Object.hasOwn(CODES, entry.code)) errorClass ??= CODES[entry.code];
    if (typeof entry.message === "string") messages.push(entry.message.slice(0, 8192));
    current = entry.cause;
  }
  const message = messages.join("\n");
  if (!errorClass) {
    if (/relation "[\w.]+" does not exist/i.test(message)) errorClass = "undefined_table";
    else if (/column "?[\w.]+"? does not exist/i.test(message)) errorClass = "undefined_column";
    else if (/permission denied for (?:table|schema|relation)/i.test(message)) errorClass = "permission_denied";
    else if (/password authentication failed|WRONGPASS/.test(message)) errorClass = "authentication";
    else if (/job_timeout|queue_.*timeout|ETIMEDOUT|command timed out/i.test(message)) errorClass = "timeout";
    else if (/ECONNREFUSED|ECONNRESET|ENOTFOUND/.test(message)) errorClass = "connection";
    else if (/job stalled more than allowable limit/i.test(message)) errorClass = "stalled";
    else if (/^overlap$/.test(message)) errorClass = "overlap";
    else if (/^budget_exhausted$/.test(message)) errorClass = "budget_exhausted";
    else if (/^discovery_failed$/.test(message)) errorClass = "discovery_failed";
    else if (/^monitoring_failed$/.test(message)) errorClass = "monitoring_failed";
    else if (/^Failed query:/i.test(message)) errorClass = "query_failed";
    else errorClass = "unknown";
  }
  // A referenced table is evidence of the query target, NOT of its failure cause.
  // Only repository-owned table identifiers can leave this function.
  const matches = [...message.matchAll(/\b(?:from|join|into|update|relation)\s+(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/gi)];
  const queryTable = matches.map((match) => match[1]!.toLowerCase()).find((name) => includes(TABLES, name)) ?? null;
  return { errorClass, queryTable };
}
export type QueueFailureGroup = {
  jobType: string; errorClass: QueueFailureClass; queryTable: string | null; count: number;
  earliestFinishedAt: string | null; latestFinishedAt: string | null; maxAttemptsMade: number;
};
export type QueueFailureSnapshot = {
  version: "queue-failures.v1"; sampledAt: string; status: "inspected" | "unavailable";
  retainedCountAtRead: number | null; sampleLimit: number; sampledJobs: number; truncated: boolean;
  errorClass: QueueFailureClass | null; groups: QueueFailureGroup[];
};
function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function boundedInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}
function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? value : null;
}
/** Reconstruct an allowlisted object before persisting or rendering metadata. */
export function readQueueFailureSnapshot(value: unknown): QueueFailureSnapshot | null {
  const raw = record(value);
  if (!raw || raw.version !== "queue-failures.v1" || !timestamp(raw.sampledAt) ||
      !includes(["inspected", "unavailable"], raw.status) || !boundedInteger(raw.sampleLimit, 100) ||
      !boundedInteger(raw.sampledJobs, raw.sampleLimit) || typeof raw.truncated !== "boolean" ||
      !(raw.retainedCountAtRead === null || boundedInteger(raw.retainedCountAtRead)) ||
      !(raw.errorClass === null || includes(QUEUE_FAILURE_CLASSES, raw.errorClass)) ||
      !Array.isArray(raw.groups) || raw.groups.length > 100) return null;
  const groups: QueueFailureGroup[] = [];
  for (const item of raw.groups) {
    const row = record(item);
    if (!row || !includes(QUEUE_OBSERVED_JOB_TYPES, row.jobType) || !includes(QUEUE_FAILURE_CLASSES, row.errorClass) ||
        !(row.queryTable === null || includes(TABLES, row.queryTable)) || !boundedInteger(row.count, 100) ||
        !boundedInteger(row.maxAttemptsMade) || !(row.earliestFinishedAt === null || timestamp(row.earliestFinishedAt)) ||
        !(row.latestFinishedAt === null || timestamp(row.latestFinishedAt))) return null;
    groups.push({ jobType: row.jobType, errorClass: row.errorClass as QueueFailureClass, queryTable: row.queryTable as string | null,
      count: row.count, earliestFinishedAt: row.earliestFinishedAt as string | null,
      latestFinishedAt: row.latestFinishedAt as string | null, maxAttemptsMade: row.maxAttemptsMade });
  }
  if (groups.reduce((sum, group) => sum + group.count, 0) !== raw.sampledJobs) return null;
  return { version: "queue-failures.v1", sampledAt: raw.sampledAt as string, status: raw.status as QueueFailureSnapshot["status"],
    retainedCountAtRead: raw.retainedCountAtRead as number | null, sampleLimit: raw.sampleLimit, sampledJobs: raw.sampledJobs,
    truncated: raw.truncated, errorClass: raw.errorClass as QueueFailureClass | null, groups };
}
