import { describe, expect, it } from "vitest";
import { MemoryWindowLimiter, clientIpFromRequestHeaders } from "./rate-limit.js";

describe("MemoryWindowLimiter", () => {
  it("allows a burst then fails closed for the rest of the window", () => {
    let now = 1_000;
    const limiter = new MemoryWindowLimiter({ windowMs: 1_000, now: () => now });
    expect(limiter.consume("ip:1", 2)).toBe(true);
    expect(limiter.consume("ip:1", 2)).toBe(true);
    expect(limiter.consume("ip:1", 2)).toBe(false);
    now = 2_100;
    expect(limiter.consume("ip:1", 2)).toBe(true);
  });
});

describe("clientIpFromRequestHeaders", () => {
  it("uses the first forwarded hop and ignores oversized values", () => {
    expect(
      clientIpFromRequestHeaders({
        get: (name) => (name === "x-forwarded-for" ? "203.0.113.10, 10.0.0.1" : null),
      }),
    ).toBe("203.0.113.10");
    expect(
      clientIpFromRequestHeaders({
        get: (name) => (name === "x-forwarded-for" ? "x".repeat(80) : null),
      }),
    ).toBe("unknown");
  });
});
