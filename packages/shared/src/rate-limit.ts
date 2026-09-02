const MAX_BUCKETS = 20_000;

export class MemoryWindowLimiter {
  private readonly buckets = new Map<string, number[]>();

  constructor(
    private readonly options: {
      maxAttempts?: number;
      windowMs?: number;
      now?: () => number;
      maxBuckets?: number;
    } = {},
  ) {}

  consume(key: string, maxAttempts = this.options.maxAttempts ?? 60): boolean {
    const now = this.options.now?.() ?? Date.now();
    const windowMs = this.options.windowMs ?? 60_000;
    const maxBuckets = this.options.maxBuckets ?? MAX_BUCKETS;
    const cutoff = now - windowMs;

    for (const [existingKey, stamps] of this.buckets) {
      const kept = stamps.filter((stamp) => stamp > cutoff);
      if (kept.length === 0) {
        this.buckets.delete(existingKey);
      } else if (kept.length !== stamps.length) {
        this.buckets.set(existingKey, kept);
      }
    }

    if (this.buckets.size >= maxBuckets && !this.buckets.has(key)) {
      return false;
    }

    const existing = this.buckets.get(key) ?? [];
    if (existing.length >= maxAttempts) {
      return false;
    }
    existing.push(now);
    this.buckets.set(key, existing);
    return true;
  }
}

export function clientIpFromRequestHeaders(headers: {
  get(name: string): string | null | undefined;
}): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim() ?? "";
    if (first && first.length <= 64) {
      return first;
    }
  }
  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp && realIp.length <= 64) {
    return realIp;
  }
  return "unknown";
}
