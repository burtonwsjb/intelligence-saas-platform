import { describe, expect, it } from "vitest";
import { decideProviderSyncDue, providerSyncBucketId } from "./schedule.js";

const now = new Date("2026-09-02T12:00:00.000Z");

describe("decideProviderSyncDue", () => {
  it("skips disabled, paused, not-enabled, interval, retry-after, and rate-limit reset", () => {
    expect(decideProviderSyncDue({ providerKey: "reddit", enabled: true, paused: false, mode: "disabled" }, now)).toEqual({
      due: false,
      reason: "disabled",
    });
    expect(decideProviderSyncDue({ providerKey: "reddit", enabled: true, paused: true, mode: "fixture" }, now)).toEqual({
      due: false,
      reason: "paused",
    });
    expect(decideProviderSyncDue({ providerKey: "reddit", enabled: false, paused: false, mode: "fixture" }, now)).toEqual({
      due: false,
      reason: "not_enabled",
    });
    expect(
      decideProviderSyncDue(
        {
          providerKey: "reddit",
          enabled: true,
          paused: false,
          mode: "fixture",
          scheduleSeconds: 900,
          lastAttemptAt: new Date("2026-09-02T11:55:00.000Z"),
        },
        now,
      ),
    ).toEqual({ due: false, reason: "interval" });
    expect(
      decideProviderSyncDue(
        {
          providerKey: "reddit",
          enabled: true,
          paused: false,
          mode: "live",
          retryAfterAt: new Date("2026-09-02T12:05:00.000Z"),
        },
        now,
      ),
    ).toEqual({ due: false, reason: "retry_after" });
    expect(
      decideProviderSyncDue(
        {
          providerKey: "tcgplayer",
          enabled: true,
          paused: false,
          mode: "live",
          rateLimitRemaining: 0,
          rateLimitResetAt: new Date("2026-09-02T12:10:00.000Z"),
        },
        now,
      ),
    ).toEqual({ due: false, reason: "rate_limit_reset" });
  });

  it("is due after the interval and when a rate-limit window has remaining quota", () => {
    expect(
      decideProviderSyncDue(
        {
          providerKey: "youtube",
          enabled: true,
          paused: false,
          mode: "fixture",
          scheduleSeconds: 60,
          lastAttemptAt: new Date("2026-09-02T11:58:00.000Z"),
        },
        now,
      ),
    ).toEqual({ due: true, reason: "schedule" });
    expect(
      decideProviderSyncDue(
        {
          providerKey: "ebay",
          enabled: true,
          paused: false,
          mode: "live",
          lastAttemptAt: new Date("2026-09-01T00:00:00.000Z"),
          rateLimitRemaining: 12,
          rateLimitResetAt: new Date("2026-09-02T12:10:00.000Z"),
        },
        now,
      ),
    ).toEqual({ due: true, reason: "schedule" });
  });

  it("uses a stable bucket id so restart recovery does not enqueue duplicates in the same window", () => {
    expect(providerSyncBucketId("reddit", 900_000, now)).toBe(providerSyncBucketId("reddit", 900_000, now));
    expect(providerSyncBucketId("reddit", 900_000, now)).not.toBe(
      providerSyncBucketId("reddit", 900_000, new Date("2026-09-02T13:00:00.000Z")),
    );
  });
});
