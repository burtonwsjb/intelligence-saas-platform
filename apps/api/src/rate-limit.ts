import { MemoryWindowLimiter, clientIpFromRequestHeaders } from "@isp/shared";

export const API_IP_LIMIT_PER_MINUTE = 300;
export const API_WEBHOOK_LIMIT_PER_MINUTE = 60;
export const API_AUTH_FAILURE_LIMIT_PER_MINUTE = 40;

const limiter = new MemoryWindowLimiter({ windowMs: 60_000 });

export function resetApiRateLimiterForTests(): void {
  (limiter as unknown as { buckets: Map<string, number[]> }).buckets?.clear?.();
}

export function allowApiRequest(input: {
  path: string;
  headers: { get(name: string): string | undefined | null };
}): boolean {
  if (input.path === "/health" || input.path === "/ready") {
    return true;
  }
  const ip = clientIpFromRequestHeaders(input.headers);
  const webhook = input.path.startsWith("/webhooks/");
  return limiter.consume(webhook ? `webhook:${ip}` : `ip:${ip}`, webhook ? API_WEBHOOK_LIMIT_PER_MINUTE : API_IP_LIMIT_PER_MINUTE);
}

export function allowApiAuthAttempt(headers: { get(name: string): string | undefined | null }): boolean {
  const ip = clientIpFromRequestHeaders(headers);
  return limiter.consume(`authfail:${ip}`, API_AUTH_FAILURE_LIMIT_PER_MINUTE);
}

/**
 * Per-API-key limit (api_key.rate_limit_per_minute), counted in fixed
 * one-minute windows so callers get a stable X-RateLimit-Reset. In memory per
 * API process: the API runs as one Railway instance, so this is the real
 * limit there; with several instances each would allow the full amount.
 */
const keyWindows = new Map<string, { window: number; count: number }>();
const MAX_KEY_WINDOWS = 10_000;

export type KeyRateDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the current window ends. */
  resetSeconds: number;
};

export function consumeKeyRateLimit(
  apiKeyId: string,
  limitPerMinute: number,
  now: number = Date.now(),
): KeyRateDecision {
  const window = Math.floor(now / 60_000);
  const resetSeconds = Math.max(1, Math.ceil(((window + 1) * 60_000 - now) / 1000));
  let entry = keyWindows.get(apiKeyId);
  if (!entry || entry.window !== window) {
    if (keyWindows.size >= MAX_KEY_WINDOWS) {
      for (const [key, value] of keyWindows) {
        if (value.window !== window) keyWindows.delete(key);
      }
    }
    entry = { window, count: 0 };
    keyWindows.set(apiKeyId, entry);
  }
  if (entry.count >= limitPerMinute) {
    return { allowed: false, limit: limitPerMinute, remaining: 0, resetSeconds };
  }
  entry.count += 1;
  return { allowed: true, limit: limitPerMinute, remaining: limitPerMinute - entry.count, resetSeconds };
}

export function resetKeyRateLimiterForTests(): void {
  keyWindows.clear();
}
