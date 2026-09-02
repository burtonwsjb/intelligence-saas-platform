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
  if (input.path === "/health" || input.path === "/ready" || input.path === "/v1/openapi.json") {
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
