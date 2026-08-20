import { describe, expect, it } from "vitest";
import {
  InvalidRuntimeEnvError,
  assertHostedSecrets,
  assertProductionIdentifiers,
  defaultPublicOrigin,
  isHostedRuntime,
  parseIspEnv,
} from "./runtime-env.js";
import { redactLogValue } from "./observe.js";

describe("runtime environment", () => {
  it("fails closed: missing ISP_ENV with NODE_ENV=production is production", () => {
    expect(parseIspEnv({ NODE_ENV: "production" })).toBe("production");
    expect(parseIspEnv({ ISP_ENV: "staging", NODE_ENV: "production" })).toBe("staging");
    expect(parseIspEnv({ NODE_ENV: "test" })).toBe("test");
    expect(parseIspEnv({})).toBe("local");
  });

  it("rejects hosted localhost, local billing, admin email allowlist, and insecure redis", () => {
    expect(() =>
      assertHostedSecrets({
        ISP_ENV: "staging",
        NODE_ENV: "production",
        APP_URL: "http://localhost:3000",
      }),
    ).toThrow(InvalidRuntimeEnvError);
    expect(() =>
      assertHostedSecrets({
        NODE_ENV: "production",
        APP_URL: "https://app.example.invalid",
        PLATFORM_ADMIN_EMAILS: "ops@example.com",
        DATABASE_ADMIN_URL: "postgresql://unused",
        APP_ADMIN_PASSWORD: "x",
      }),
    ).toThrow(/PLATFORM_ADMIN_EMAILS/);
    expect(() =>
      assertHostedSecrets({
        NODE_ENV: "production",
        APP_URL: "https://app.example.invalid",
        BILLING_MODE: "local_simulation",
        DATABASE_ADMIN_URL: "postgresql://unused",
        APP_ADMIN_PASSWORD: "x",
      }),
    ).toThrow(/billing simulation/);
    expect(
      isHostedRuntime({
        ISP_ENV: "staging",
        NODE_ENV: "production",
      }),
    ).toBe(true);
    expect(() =>
      assertProductionIdentifiers({
        ISP_ENV: "production",
        APP_URL: "https://staging.example.invalid",
      }),
    ).toThrow(/staging hostname/);
  });

  it("allows localhost only in local mode and redacts secrets from logs", () => {
    expect(defaultPublicOrigin({ ISP_ENV: "local" })).toBe("http://localhost:3000");
    expect(redactLogValue("sk_test_not_for_logs")).toBe("[redacted]");
    expect(redactLogValue("ok")).toBe("ok");
  });
});
