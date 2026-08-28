import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EmailDeliveryFailedError } from "./mail/provider.js";
import { createAuth } from "./auth.js";
import { createMemoryInbox } from "./email.js";
import { createTestDatabase } from "./test-db.js";
import {
  MemoryVerificationResendLimiter,
  VERIFICATION_RESEND_MAX_ATTEMPTS,
  clientIpFromHeaders,
  hashVerificationResendValue,
  normalizeVerificationEmail,
  resendVerificationEmail,
} from "./verification-resend.js";

const testEnv = {
  BETTER_AUTH_SECRET: "test-only-secret-not-for-production-use!!",
  BETTER_AUTH_URL: "http://localhost:3000",
  APP_URL: "http://localhost:3000",
  NODE_ENV: "test",
  AUTH_EMAIL_MODE: "memory",
};

const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "verification-resend.ts");

async function signupUnverified(email: string) {
  const db = await createTestDatabase();
  const inbox = createMemoryInbox();
  const auth = createAuth({
    db,
    env: testEnv,
    emailDelivery: inbox.delivery,
  });
  await auth.api.signUpEmail({
    body: { email, password: "correct-horse-battery", name: "Member" },
  });
  return { auth, inbox };
}

describe("verification resend helpers", () => {
  it("normalizes emails and hashes limiter keys without exposing the address", () => {
    expect(normalizeVerificationEmail("  Alex@Example.COM ")).toBe("alex@example.com");
    expect(normalizeVerificationEmail("not-an-email")).toBeNull();
    expect(hashVerificationResendValue("alex@example.com")).toMatch(/^[a-f0-9]{64}$/);
    expect(hashVerificationResendValue("alex@example.com")).not.toContain("alex@example.com");
    expect(clientIpFromHeaders(new Headers({ "x-forwarded-for": "203.0.113.8, 10.0.0.1" }))).toBe(
      "203.0.113.8",
    );
  });

  it("does not mint verification tokens outside Better Auth", () => {
    const source = readFileSync(sourcePath, "utf8");
    expect(source).not.toMatch(/createEmailVerificationToken/);
    expect(source).not.toMatch(/signJWT/);
    expect(source).toMatch(/sendVerificationEmail/);
  });
});

describe("verification resend limiter", () => {
  it("allows a bounded number of attempts per window and then fails closed", () => {
    let now = 1_000;
    const limiter = new MemoryVerificationResendLimiter({
      now: () => now,
      maxAttempts: 5,
      windowMs: 3_600_000,
    });
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.consume("email:abc")).toBe(true);
    }
    expect(limiter.consume("email:abc")).toBe(false);
    now += 3_600_000;
    expect(limiter.consume("email:abc")).toBe(true);
  });

  it("fails closed when the limiter cannot accept new buckets", () => {
    const limiter = new MemoryVerificationResendLimiter({ maxBuckets: 1 });
    expect(limiter.consume("one")).toBe(true);
    expect(() => limiter.consume("two")).toThrow(/exhausted/);
  });
});

describe("resendVerificationEmail", () => {
  it("resends through Better Auth for the signed-up email", async () => {
    const { auth, inbox } = await signupUnverified("owner@example.com");
    expect(inbox.messages).toHaveLength(1);
    const firstUrl = inbox.messages[0]!.url;
    const limiter = new MemoryVerificationResendLimiter();

    const result = await resendVerificationEmail({
      auth,
      email: "  Owner@Example.com ",
      ip: "203.0.113.10",
      limiter,
    });

    expect(result).toEqual({ outcome: "sent" });
    expect(JSON.stringify(result)).not.toMatch(/token/i);
    expect(JSON.stringify(result)).not.toContain(firstUrl);
    expect(inbox.messages).toHaveLength(2);
    expect(inbox.messages[1]!.to).toBe("owner@example.com");
    const secondUrl = new URL(inbox.messages[1]!.url);
    expect(secondUrl.searchParams.get("token")).toBeTruthy();
    expect(secondUrl.pathname).toContain("verify-email");
    expect(JSON.stringify(result)).not.toContain(secondUrl.searchParams.get("token"));
  });

  it("does not reveal whether an account exists", async () => {
    const { auth, inbox } = await signupUnverified("owner@example.com");
    const limiter = new MemoryVerificationResendLimiter();
    const known = await resendVerificationEmail({
      auth,
      email: "owner@example.com",
      ip: "203.0.113.11",
      limiter,
    });
    const unknown = await resendVerificationEmail({
      auth,
      email: "missing@example.com",
      ip: "203.0.113.12",
      limiter,
    });
    const verifiedDb = await createTestDatabase();
    const verifiedInbox = createMemoryInbox();
    const verifiedAuth = createAuth({
      db: verifiedDb,
      env: testEnv,
      emailDelivery: verifiedInbox.delivery,
    });
    await verifiedAuth.api.signUpEmail({
      body: {
        email: "verified@example.com",
        password: "correct-horse-battery",
        name: "Verified",
      },
    });
    const token = new URL(verifiedInbox.messages[0]!.url).searchParams.get("token")!;
    await verifiedAuth.api.verifyEmail({ query: { token } });
    const alreadyVerified = await resendVerificationEmail({
      auth: verifiedAuth,
      email: "verified@example.com",
      ip: "203.0.113.13",
      limiter: new MemoryVerificationResendLimiter(),
    });

    expect(known).toEqual({ outcome: "sent" });
    expect(unknown).toEqual(known);
    expect(alreadyVerified).toEqual(known);
    expect(inbox.messages.filter((item) => item.to === "missing@example.com")).toHaveLength(0);
    expect(verifiedInbox.messages).toHaveLength(1);
    expect(JSON.stringify(unknown)).not.toMatch(/not found|exist|unknown user/i);
  });

  it("rate limits by hashed email and IP and returns a generic failure", async () => {
    const auth = {
      api: {
        sendVerificationEmail: vi.fn(async () => ({ status: true })),
      },
    };
    const limiter = new MemoryVerificationResendLimiter({
      maxAttempts: VERIFICATION_RESEND_MAX_ATTEMPTS,
    });
    for (let i = 0; i < VERIFICATION_RESEND_MAX_ATTEMPTS; i += 1) {
      await expect(
        resendVerificationEmail({
          auth,
          email: "repeat@example.com",
          ip: "198.51.100.4",
          limiter,
        }),
      ).resolves.toEqual({ outcome: "sent" });
    }
    const limited = await resendVerificationEmail({
      auth,
      email: "repeat@example.com",
      ip: "198.51.100.4",
      limiter,
    });
    expect(limited).toEqual({ outcome: "unavailable" });
    expect(JSON.stringify(limited)).not.toContain("repeat@example.com");
    expect(auth.api.sendVerificationEmail).toHaveBeenCalledTimes(VERIFICATION_RESEND_MAX_ATTEMPTS);

    const ipLimiter = new MemoryVerificationResendLimiter();
    for (let i = 0; i < VERIFICATION_RESEND_MAX_ATTEMPTS; i += 1) {
      await resendVerificationEmail({
        auth,
        email: `user${i}@example.com`,
        ip: "198.51.100.9",
        limiter: ipLimiter,
      });
    }
    await expect(
      resendVerificationEmail({
        auth,
        email: "extra@example.com",
        ip: "198.51.100.9",
        limiter: ipLimiter,
      }),
    ).resolves.toEqual({ outcome: "unavailable" });
  });

  it("returns a generic failure when the provider is unavailable", async () => {
    const db = await createTestDatabase();
    const inbox = createMemoryInbox();
    const authOk = createAuth({
      db,
      env: testEnv,
      emailDelivery: inbox.delivery,
    });
    await authOk.api.signUpEmail({
      body: {
        email: "fail@example.com",
        password: "correct-horse-battery",
        name: "Fail",
      },
    });
    const authFail = createAuth({
      db,
      env: testEnv,
      emailDelivery: {
        async send() {
          throw new EmailDeliveryFailedError(
            "Resend delivery failed (503) https://example.test/verify-email?token=leak_token_value",
          );
        },
      },
    });

    const logs: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((message) => {
      logs.push(typeof message === "string" ? message : JSON.stringify(message));
    });
    const result = await resendVerificationEmail({
      auth: authFail,
      email: "fail@example.com",
      ip: "203.0.113.20",
      limiter: new MemoryVerificationResendLimiter(),
    });
    errorSpy.mockRestore();

    expect(result).toEqual({ outcome: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("leak_token_value");
    expect(JSON.stringify(result)).not.toContain("fail@example.com");
    expect(logs.join("\n")).not.toContain("leak_token_value");
    expect(logs.join("\n")).not.toContain("fail@example.com");
  });

  it("fails closed when the limiter throws", async () => {
    const result = await resendVerificationEmail({
      auth: {
        api: {
          sendVerificationEmail: async () => ({ status: true }),
        },
      },
      email: "owner@example.com",
      ip: "203.0.113.21",
      limiter: {
        consume() {
          throw new Error("redis down");
        },
      },
    });
    expect(result).toEqual({ outcome: "unavailable" });
  });

  it("treats invalid email input as a generic success so existence is not leaked", async () => {
    const send = vi.fn(async () => ({ status: true }));
    const result = await resendVerificationEmail({
      auth: { api: { sendVerificationEmail: send } },
      email: "not-an-email",
      ip: "203.0.113.22",
      limiter: new MemoryVerificationResendLimiter(),
    });
    expect(result).toEqual({ outcome: "sent" });
    expect(send).not.toHaveBeenCalled();
  });
});
