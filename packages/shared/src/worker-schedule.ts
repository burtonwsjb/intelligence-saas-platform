/** No I/O. The scheduler uses Phoenix wall time and never performs catch-up bursts. */
export const WORKER_TIME_ZONE = "America/Phoenix";
export const FREE_REDIS_POLICY = Object.freeze({
  monthlyCommandCeiling: 400_000,
  dailyCommandAllowance: 12_000,
  batchCommandAllowance: 600,
  // The free transport drains the existing Postgres outbox: actual Redis cost is zero.
  redisCommandsPerFreeBatch: 0,
});
export const SCHEDULE_DEFAULTS = Object.freeze({
  intervalHours: 1,
  quietStartHour: 2,
  quietEndHour: 6,
  admissionMinutes: 5,
  maxJobs: 60,
  maxRunMs: 180_000,
});
const clock = new Intl.DateTimeFormat("en-CA", {
  timeZone: WORKER_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
export function phoenixClock(at: Date) {
  if (!Number.isFinite(at.getTime())) throw new Error("invalid_schedule_time");
  const parts = Object.fromEntries(clock.formatToParts(at).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}
export function scheduledSlot(at: Date, intervalHours = 1): string | null {
  if (![1, 2, 4].includes(intervalHours)) throw new Error("invalid_schedule_interval");
  const { day, hour, minute } = phoenixClock(at);
  if ((hour >= 2 && hour < 6) || minute >= SCHEDULE_DEFAULTS.admissionMinutes) return null;
  // Anchor every supported interval at the owner's 06:00 wake-up time.
  if (((hour + 24 - 6) % 24) % intervalHours !== 0) return null;
  return `${day}T${String(hour).padStart(2, "0")}:00-07:00`;
}
export function nextScheduledAt(at: Date, intervalHours = 1): Date {
  if (!Number.isFinite(at.getTime())) throw new Error("invalid_schedule_time");
  let next = new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000 + 3_600_000);
  for (let i = 0; i < 48; i++, next = new Date(next.getTime() + 3_600_000)) {
    if (scheduledSlot(next, intervalHours)) return next;
  }
  throw new Error("invalid_schedule_interval");
}
export function broadDiscoveryDue(at: Date): boolean {
  const { hour } = phoenixClock(at);
  return hour === 6 || hour === 12 || hour === 18;
}
