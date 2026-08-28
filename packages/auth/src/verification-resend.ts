import { createHash } from "node:crypto";
import { structuredLog } from "@isp/shared";

export const VERIFICATION_RESEND_MAX_ATTEMPTS = 5;
export const VERIFICATION_RESEND_WINDOW_MS = 60 * 60 * 1000;
export const VERIFICATION_RESEND_CALLBACK_URL = "/onboarding";

const MAX_LIMITER_BUCKETS = 20_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type VerificationResendOutcome = "sent" | "unavailable";

export type VerificationResendResult = {
  outcome: VerificationResendOutcome;
};

export interface VerificationResendLimiter {
  consume(key: string): boolean;
}

export type VerificationEmailSender = {
  api: {
    sendVerificationEmail: (args: {
      body: { email: string; callbackURL?: string };
    }) => Promise<{ status?: boolean } | void>;
  };
};

export class MemoryVerificationResendLimiter implements VerificationResendLimiter {
  private readonly buckets = new Map<string, number[]>();

  constructor(
    private readonly options: {
      maxAttempts?: number;
      windowMs?: number;
      now?: () => number;
      maxBuckets?: number;
    } = {},
  ) {}

  consume(key: string): boolean {
    const now = this.options.now?.() ?? Date.now();
    const windowMs = this.options.windowMs ?? VERIFICATION_RESEND_WINDOW_MS;
    const maxAttempts = this.options.maxAttempts ?? VERIFICATION_RESEND_MAX_ATTEMPTS;
    const maxBuckets = this.options.maxBuckets ?? MAX_LIMITER_BUCKETS;
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
      throw new Error("verification_resend_limiter_exhausted");
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

let defaultLimiter: MemoryVerificationResendLimiter | undefined;

export function getVerificationResendLimiter(): MemoryVerificationResendLimiter {
  defaultLimiter ??= new MemoryVerificationResendLimiter();
  return defaultLimiter;
}

export function resetVerificationResendLimiterForTests(): void {
  defaultLimiter = undefined;
}

export function normalizeVerificationEmail(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    return null;
  }
  return email;
}

export function hashVerificationResendValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function clientIpFromHeaders(headers: Headers): string {
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

export async function resendVerificationEmail(input: {
  auth: VerificationEmailSender;
  email: unknown;
  ip: string;
  limiter: VerificationResendLimiter;
  callbackURL?: string;
}): Promise<VerificationResendResult> {
  const email = normalizeVerificationEmail(input.email);
  if (!email) {
    return { outcome: "sent" };
  }

  const ip = input.ip.trim() || "unknown";
  try {
    const emailAllowed = input.limiter.consume(
      `email:${hashVerificationResendValue(email)}`,
    );
    const ipAllowed = input.limiter.consume(`ip:${hashVerificationResendValue(ip)}`);
    if (!emailAllowed || !ipAllowed) {
      return { outcome: "unavailable" };
    }
  } catch {
    return { outcome: "unavailable" };
  }

  try {
    await input.auth.api.sendVerificationEmail({
      body: {
        email,
        callbackURL: input.callbackURL ?? VERIFICATION_RESEND_CALLBACK_URL,
      },
    });
    return { outcome: "sent" };
  } catch {
    structuredLog("error", "auth.verification_resend_failed", { reason: "provider" });
    return { outcome: "unavailable" };
  }
}
