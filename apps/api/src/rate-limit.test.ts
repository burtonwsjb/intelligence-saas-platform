import { describe, expect, it } from "vitest";
import { API_WEBHOOK_LIMIT_PER_MINUTE, allowApiRequest } from "./rate-limit.js";

describe("allowApiRequest", () => {
  it("does not rate-limit health and blocks a webhook flood from one IP", () => {
    const headers = { get: (name: string) => (name === "x-forwarded-for" ? "198.51.100.20" : null) };
    expect(allowApiRequest({ path: "/health", headers })).toBe(true);
    expect(allowApiRequest({ path: "/ready", headers })).toBe(true);
    let allowed = 0;
    let denied = 0;
    for (let i = 0; i < API_WEBHOOK_LIMIT_PER_MINUTE + 5; i += 1) {
      if (allowApiRequest({ path: "/webhooks/stripe", headers })) {
        allowed += 1;
      } else {
        denied += 1;
      }
    }
    expect(allowed).toBe(API_WEBHOOK_LIMIT_PER_MINUTE);
    expect(denied).toBe(5);
  });
});
