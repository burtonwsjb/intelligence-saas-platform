import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MemoryVerificationResendLimiter,
  MissingAuthSecretError,
  resendVerificationEmail,
} from "@isp/auth";
import {
  VERIFICATION_COOLDOWN_MS,
  VERIFICATION_SENT_MESSAGE,
  VERIFICATION_UNAVAILABLE_MESSAGE,
  formatResendCountdown,
  persistVerificationResendState,
  readVerificationResendState,
  remainingCooldownSeconds,
} from "./verification-cooldown";
import {
  handleVerificationResendRequest,
  isAllowedVerificationOrigin,
  isSendVerificationEmailPath,
  verificationResendJson,
} from "./verification-resend";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    getItem(key: string) {
      return data[key] ?? null;
    },
    setItem(key: string, value: string) {
      data[key] = value;
    },
  };
}

describe("verification email cooldown", () => {
  it("persists the signup email and a 60 second cooldown", () => {
    const storage = memoryStorage();
    const now = 1_700_000_000_000;
    persistVerificationResendState("  Alex@Example.COM ", now, storage);
    const stored = readVerificationResendState(storage);
    expect(stored.email).toBe("alex@example.com");
    expect(stored.cooldownUntil).toBe(now + VERIFICATION_COOLDOWN_MS);
    expect(remainingCooldownSeconds(stored.cooldownUntil, now)).toBe(60);
    expect(remainingCooldownSeconds(stored.cooldownUntil, now + 18_000)).toBe(42);
    expect(formatResendCountdown(42)).toBe("You can resend in 42 seconds");
    expect(remainingCooldownSeconds(stored.cooldownUntil, now + VERIFICATION_COOLDOWN_MS)).toBe(0);
  });
});

describe("verification resend HTTP wrapper", () => {
  it("returns a generic success payload without echoing the email or tokens", async () => {
    const send = vi.fn(async () => ({ outcome: "sent" as const }));
    const request = new Request("http://localhost:3000/api/verification/resend", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
        "x-forwarded-for": "203.0.113.30",
      },
      body: JSON.stringify({
        email: "owner@example.com",
        token: "secret_token_value",
      }),
    });
    const response = await handleVerificationResendRequest(request, {
      getAuth: () => ({ api: {} }) as never,
      limiter: new MemoryVerificationResendLimiter(),
      send,
      env: { APP_URL: "http://localhost:3000" },
      isAuthConfigError: () => false,
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ ok: true });
    expect(text).not.toContain("owner@example.com");
    expect(text).not.toContain("secret_token_value");
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "owner@example.com",
        ip: "203.0.113.30",
      }),
    );
  });

  it("applies server-side rate limiting with a generic response", async () => {
    const auth = {
      api: {
        sendVerificationEmail: vi.fn(async () => ({ status: true })),
      },
    };
    const limiter = new MemoryVerificationResendLimiter({ maxAttempts: 5 });
    const deps = {
      getAuth: () => auth as never,
      limiter,
      send: resendVerificationEmail,
      env: { APP_URL: "http://localhost:3000" },
      isAuthConfigError: () => false,
    };
    for (let i = 0; i < 5; i += 1) {
      const response = await handleVerificationResendRequest(
        new Request("http://localhost:3000/api/verification/resend", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": "198.51.100.20",
          },
          body: JSON.stringify({ email: "owner@example.com" }),
        }),
        deps,
      );
      expect(await response.json()).toEqual({ ok: true });
    }
    const limited = await handleVerificationResendRequest(
      new Request("http://localhost:3000/api/verification/resend", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "198.51.100.20",
        },
        body: JSON.stringify({ email: "owner@example.com" }),
      }),
      deps,
    );
    const body = await limited.json();
    expect(limited.status).toBe(200);
    expect(body).toEqual({ ok: false });
    expect(JSON.stringify(body)).not.toContain("owner@example.com");
    expect(auth.api.sendVerificationEmail).toHaveBeenCalledTimes(5);
  });

  it("maps provider failure to a generic payload", async () => {
    const response = await handleVerificationResendRequest(
      new Request("http://localhost:3000/api/verification/resend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "owner@example.com" }),
      }),
      {
        getAuth: () => ({ api: {} }) as never,
        limiter: new MemoryVerificationResendLimiter(),
        send: async () => ({ outcome: "unavailable" }),
        env: {},
        isAuthConfigError: () => false,
      },
    );
    expect(await response.json()).toEqual({ ok: false });
  });

  it("does not distinguish unknown accounts in the HTTP body", async () => {
    const send = vi.fn(async () => ({ outcome: "sent" as const }));
    const deps = {
      getAuth: () => ({ api: {} }) as never,
      limiter: new MemoryVerificationResendLimiter(),
      send,
      env: {},
      isAuthConfigError: () => false,
    };
    const known = await handleVerificationResendRequest(
      new Request("http://localhost:3000/api/verification/resend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "owner@example.com" }),
      }),
      deps,
    );
    const unknown = await handleVerificationResendRequest(
      new Request("http://localhost:3000/api/verification/resend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "missing@example.com" }),
      }),
      deps,
    );
    expect(await known.json()).toEqual({ ok: true });
    expect(await unknown.json()).toEqual({ ok: true });
    expect(verificationResendJson({ outcome: "sent" }).status).toBe(200);
  });

  it("rejects disallowed origins without describing accounts", async () => {
    const send = vi.fn(async () => ({ outcome: "sent" as const }));
    const response = await handleVerificationResendRequest(
      new Request("http://localhost:3000/api/verification/resend", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
        },
        body: JSON.stringify({ email: "owner@example.com" }),
      }),
      {
        getAuth: () => ({ api: {} }) as never,
        limiter: new MemoryVerificationResendLimiter(),
        send,
        env: { APP_URL: "https://isp-staging-web.vercel.app" },
        isAuthConfigError: () => false,
      },
    );
    expect(await response.json()).toEqual({ ok: false });
    expect(send).not.toHaveBeenCalled();
    expect(isAllowedVerificationOrigin("https://evil.example", ["https://isp-staging-web.vercel.app"])).toBe(
      false,
    );
  });

  it("returns the generic auth configuration payload when auth is not configured", async () => {
    const response = await handleVerificationResendRequest(
      new Request("http://localhost:3000/api/verification/resend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "owner@example.com" }),
      }),
      {
        getAuth: () => {
          throw new MissingAuthSecretError();
        },
        limiter: new MemoryVerificationResendLimiter(),
        send: async () => ({ outcome: "sent" }),
        env: {},
        isAuthConfigError: (error) => error instanceof MissingAuthSecretError,
      },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Authentication is not configured." });
  });

  it("routes Better Auth's send-verification-email path through the wrapper", () => {
    expect(isSendVerificationEmailPath("/api/auth/send-verification-email")).toBe(true);
    expect(isSendVerificationEmailPath("/api/auth/sign-up/email")).toBe(false);
  });
});

describe("hosted verify-email copy", () => {
  it("removes stale local-development copy and keeps the sign-in link", () => {
    const panel = readFileSync(path.join(webRoot, "components/VerifyEmailPanel.tsx"), "utf8");
    const page = readFileSync(path.join(webRoot, "app/verify-email/page.tsx"), "utf8");
    const form = readFileSync(path.join(webRoot, "components/AuthForm.tsx"), "utf8");
    const route = readFileSync(path.join(webRoot, "app/api/auth/[...all]/route.ts"), "utf8");
    const cooldown = readFileSync(path.join(webRoot, "lib/verification-cooldown.ts"), "utf8");
    const combined = `${panel}\n${page}\n${cooldown}`;

    expect(combined).toContain("Verify your email");
    expect(combined).toContain(
      "We sent a verification link to your email address. Click the link to finish setting up",
    );
    expect(combined).toContain("Check your spam folder or resend the verification email.");
    expect(combined).toContain("Resend verification email");
    expect(combined).toContain('href="/login"');
    expect(combined).toContain("Back to sign in");
    expect(combined).toContain('aria-live="polite"');
    expect(combined).toContain('role="status"');
    expect(combined).toContain("verify-email-slot");
    expect(combined).toContain(VERIFICATION_SENT_MESSAGE);
    expect(combined).toContain(VERIFICATION_UNAVAILABLE_MESSAGE);
    expect(combined).not.toMatch(/Local development writes or logs that link/i);
    expect(combined).not.toMatch(/later email phase/i);
    expect(combined).not.toMatch(/Production email sending is reserved/i);
    expect(form).toContain("persistVerificationResendState");
    expect(route).toContain("isSendVerificationEmailPath");
    expect(route).toContain("handleVerificationResendRequest");
  });
});
