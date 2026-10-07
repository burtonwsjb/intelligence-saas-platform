import { describe, expect, it } from "vitest";
import { FREE_REDIS_POLICY, broadDiscoveryDue, nextScheduledAt, phoenixClock, scheduledSlot } from "./worker-schedule.js";

// Phoenix is UTC-7 all year: no daylight saving shifts the schedule.
const phoenix = (day: string, hour: number, minute = 0) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + (hour + 7) * 3_600_000 + minute * 60_000);

describe("Phoenix worker schedule", () => {
  it("reads Phoenix wall time in winter and summer alike", () => {
    expect(phoenixClock(new Date("2026-01-15T13:30:00Z"))).toEqual({ day: "2026-01-15", hour: 6, minute: 30 });
    expect(phoenixClock(new Date("2026-07-15T13:30:00Z"))).toEqual({ day: "2026-07-15", hour: 6, minute: 30 });
  });

  it("admits only the first five minutes of an hour outside 02:00-06:00", () => {
    expect(scheduledSlot(phoenix("2026-03-10", 6, 0))).toBe("2026-03-10T06:00-07:00");
    expect(scheduledSlot(phoenix("2026-03-10", 6, 4))).toBe("2026-03-10T06:00-07:00");
    expect(scheduledSlot(phoenix("2026-03-10", 6, 5))).toBeNull();
    expect(scheduledSlot(phoenix("2026-03-10", 1, 0))).toBe("2026-03-10T01:00-07:00");
    for (const hour of [2, 3, 4, 5]) expect(scheduledSlot(phoenix("2026-03-10", hour, 0))).toBeNull();
  });

  it("anchors 2- and 4-hour intervals at 06:00", () => {
    expect(scheduledSlot(phoenix("2026-03-10", 8, 1), 2)).not.toBeNull();
    expect(scheduledSlot(phoenix("2026-03-10", 9, 1), 2)).toBeNull();
    expect(scheduledSlot(phoenix("2026-03-10", 10, 1), 4)).not.toBeNull();
    expect(scheduledSlot(phoenix("2026-03-10", 12, 1), 4)).toBeNull();
    expect(() => scheduledSlot(new Date(), 3)).toThrow("invalid_schedule_interval");
  });

  it("schedules the next slot without catch-up bursts across quiet hours", () => {
    expect(nextScheduledAt(phoenix("2026-03-10", 13, 30)).toISOString()).toBe(phoenix("2026-03-10", 14, 0).toISOString());
    expect(nextScheduledAt(phoenix("2026-03-10", 1, 2)).toISOString()).toBe(phoenix("2026-03-10", 6, 0).toISOString());
    expect(nextScheduledAt(phoenix("2026-03-10", 7, 0), 4).toISOString()).toBe(phoenix("2026-03-10", 10, 0).toISOString());
    expect(() => nextScheduledAt(new Date(Number.NaN))).toThrow("invalid_schedule_time");
  });

  it("keeps the free transport at zero Redis commands inside the free-tier ceilings", () => {
    expect(FREE_REDIS_POLICY.redisCommandsPerFreeBatch).toBe(0);
    expect(FREE_REDIS_POLICY.batchCommandAllowance * 20).toBe(FREE_REDIS_POLICY.dailyCommandAllowance);
    expect(FREE_REDIS_POLICY.dailyCommandAllowance * 31).toBeLessThan(FREE_REDIS_POLICY.monthlyCommandCeiling);
  });

  it("runs broad discovery three times a day", () => {
    expect([6, 12, 18].every((hour) => broadDiscoveryDue(phoenix("2026-03-10", hour, 0)))).toBe(true);
    expect(broadDiscoveryDue(phoenix("2026-03-10", 7, 0))).toBe(false);
  });
});
