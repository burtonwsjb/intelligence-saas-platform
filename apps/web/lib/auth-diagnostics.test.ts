import { describe, expect, it } from "vitest";
import {
  buildAuthConfigDiagnostic,
  sanitizeAuthErrorMessage,
  serializeAuthConfigDiagnostic,
} from "./auth-diagnostics";

const SECRET = "super-secret-value-do-not-log-xyz";
const DATABASE_URL = "postgresql://app_user:hunter2@db.example.internal/neondb?sslmode=require";
const REDIS_URL = "rediss://default:redis-token@redis.example.internal:6379";
const TOKEN = "sk_test_thisMustNeverAppearInLogs";

describe("hosted auth diagnostics", () => {
  const env: NodeJS.ProcessEnv = {
    ISP_ENV: "staging",
    APP_DATABASE_URL: DATABASE_URL,
    BETTER_AUTH_SECRET: SECRET,
    APP_URL: "https://isp-staging-web.vercel.app",
    BETTER_AUTH_URL: "https://isp-staging-web.vercel.app",
    BILLING_MODE: "stripe_test",
    AUTH_EMAIL_MODE: "resend",
    REDIS_URL,
  };

  it("logs only allowlisted fields and never secret values", () => {
    const error = new Error(
      `Authentication failed ${DATABASE_URL} secret=${SECRET} Authorization: Bearer ${TOKEN}`,
    );
    error.name = "MissingAppDatabaseUrlError";
    const line = serializeAuthConfigDiagnostic(error, env);
    const parsed = JSON.parse(line) as Record<string, unknown>;

    expect(parsed.event).toBe("auth.config_error");
    expect(parsed.error_name).toBe("MissingAppDatabaseUrlError");
    expect(parsed.ISP_ENV).toBe("staging");
    expect(parsed.APP_DATABASE_URL_present).toBe(true);
    expect(parsed.BETTER_AUTH_SECRET_present).toBe(true);
    expect(parsed.BETTER_AUTH_SECRET_length).toBe(SECRET.length);
    expect(parsed.APP_URL_present).toBe(true);
    expect(parsed.BETTER_AUTH_URL_present).toBe(true);
    expect(parsed.BILLING_MODE_present).toBe(true);
    expect(parsed.AUTH_EMAIL_MODE_present).toBe(true);

    expect(line).not.toContain(SECRET);
    expect(line).not.toContain("hunter2");
    expect(line).not.toContain(DATABASE_URL);
    expect(line).not.toContain("postgresql://");
    expect(line).not.toContain("db.example.internal");
    expect(line).not.toContain(REDIS_URL);
    expect(line).not.toContain(TOKEN);
    expect(line).not.toContain("redis-token");
    expect(line).not.toMatch(/cookie/i);
    expect(line).not.toMatch(/header/i);
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "APP_DATABASE_URL_present",
        "APP_URL_present",
        "AUTH_EMAIL_MODE_present",
        "BETTER_AUTH_SECRET_length",
        "BETTER_AUTH_SECRET_present",
        "BETTER_AUTH_URL_present",
        "BILLING_MODE_present",
        "ISP_ENV",
        "error_message",
        "error_name",
        "event",
      ].sort(),
    );
  });

  it("does not put configuration details into the client-facing payload", () => {
    const diagnostic = buildAuthConfigDiagnostic(new Error(DATABASE_URL), env);
    const client = JSON.stringify({ error: "Authentication is not configured." });
    expect(client).toBe('{"error":"Authentication is not configured."}');
    expect(client).not.toContain(diagnostic.error_name);
    expect(client).not.toContain("APP_DATABASE_URL");
    expect(client).not.toContain(SECRET);
  });

  it("records absence and zero secret length without leaking values", () => {
    const line = serializeAuthConfigDiagnostic(new Error("BETTER_AUTH_SECRET is missing or too short."), {
      ISP_ENV: "staging",
      BETTER_AUTH_SECRET: "   ",
    });
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.BETTER_AUTH_SECRET_present).toBe(false);
    expect(parsed.BETTER_AUTH_SECRET_length).toBe(0);
    expect(parsed.APP_DATABASE_URL_present).toBe(false);
    expect(parsed.ISP_ENV).toBe("staging");
    expect(line).not.toContain(SECRET);
  });

  it("redacts connection strings and credential material from error messages", () => {
    expect(sanitizeAuthErrorMessage(`bad ${DATABASE_URL}`)).toBe("bad [redacted]");
    expect(sanitizeAuthErrorMessage(`token ${TOKEN}`)).toBe("token [redacted]");
    expect(sanitizeAuthErrorMessage("APP_URL is required.")).toBe("APP_URL is required.");
  });
});
