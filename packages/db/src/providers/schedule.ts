import { DEFAULT_SCHEDULE_SECONDS, type ProviderKey } from "./catalog.js";

export type ProviderDueReason =
  | "schedule"
  | "disabled"
  | "paused"
  | "not_enabled"
  | "interval"
  | "retry_after"
  | "rate_limit_reset";

export type ProviderDueDecision =
  | { due: true; reason: "schedule" }
  | { due: false; reason: Exclude<ProviderDueReason, "schedule"> };

export type ProviderScheduleRow = {
  providerKey: string;
  enabled: boolean;
  paused: boolean;
  mode: string;
  scheduleSeconds?: number | null;
  lastAttemptAt?: Date | null;
  retryAfterAt?: Date | null;
  rateLimitRemaining?: number | null;
  rateLimitResetAt?: Date | null;
};

export function decideProviderSyncDue(
  row: ProviderScheduleRow,
  now = new Date(),
): ProviderDueDecision {
  if (row.mode === "disabled") {
    return { due: false, reason: "disabled" };
  }
  if (row.paused) {
    return { due: false, reason: "paused" };
  }
  if (!row.enabled) {
    return { due: false, reason: "not_enabled" };
  }
  if (row.retryAfterAt && row.retryAfterAt.getTime() > now.getTime()) {
    return { due: false, reason: "retry_after" };
  }
  if (
    row.rateLimitResetAt &&
    row.rateLimitResetAt.getTime() > now.getTime() &&
    (row.rateLimitRemaining == null || row.rateLimitRemaining <= 0)
  ) {
    return { due: false, reason: "rate_limit_reset" };
  }
  const interval =
    (row.scheduleSeconds ||
      DEFAULT_SCHEDULE_SECONDS[row.providerKey as ProviderKey] ||
      900) * 1000;
  const last = row.lastAttemptAt?.getTime() ?? 0;
  if (now.getTime() - last < interval) {
    return { due: false, reason: "interval" };
  }
  return { due: true, reason: "schedule" };
}

export function providerSyncBucketId(providerKey: string, intervalMs: number, now = new Date()): string {
  const safeInterval = Math.max(intervalMs, 1_000);
  return `provider.sync.v1:${providerKey}:${Math.floor(now.getTime() / safeInterval)}`;
}
