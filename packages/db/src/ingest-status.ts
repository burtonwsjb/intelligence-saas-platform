import { SOURCE_EVENT_STATUSES, type SourceEventStatus } from "./schema/ingest.js";

export type { SourceEventStatus };

const ALLOWED: Record<SourceEventStatus, readonly SourceEventStatus[]> = {
  received: ["queued", "processing", "failed"],
  queued: ["processing", "failed"],
  processing: ["processed", "failed", "processing"],
  processed: ["processed"],
  failed: ["failed"],
};

export function isSourceEventStatus(value: string): value is SourceEventStatus {
  return (SOURCE_EVENT_STATUSES as readonly string[]).includes(value);
}

export function canTransitionSourceEvent(
  from: string,
  to: SourceEventStatus,
): boolean {
  if (!isSourceEventStatus(from)) {
    return false;
  }
  return ALLOWED[from].includes(to);
}
