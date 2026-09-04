export type QueueJobCountInput = {
  wait?: number | null;
  waiting?: number | null;
  active?: number | null;
  paused?: number | null;
  failed?: number | null;
  [key: string]: number | null | undefined;
};

function firstFiniteCount(...values: Array<number | null | undefined>): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return 0;
}

export function readQueueJobCounts(counts: QueueJobCountInput): {
  queueDepth: number;
  failedJobs: number;
} {
  return {
    queueDepth: firstFiniteCount(counts.wait, counts.waiting) + firstFiniteCount(counts.active),
    failedJobs: firstFiniteCount(counts.failed),
  };
}
