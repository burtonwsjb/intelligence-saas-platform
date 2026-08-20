const FORBIDDEN =
  /authorization|api[_-]?key|password|secret|token|pepper|whsec_|sk_live_|sk_test_|isp_(?:test|live)_|redis:\/\/[^@]+@|rediss:\/\/[^@]+@|postgresql:\/\/[^@]+@/i;

export type LogLevel = "info" | "warn" | "error";

export function redactLogValue(value: unknown): string | number | boolean | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  const text = String(value);
  if (FORBIDDEN.test(text)) {
    return "[redacted]";
  }
  return text;
}

export function structuredLog(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const safe: Record<string, string | number | boolean | null> = { event };
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN.test(key)) {
      continue;
    }
    safe[key] = redactLogValue(value);
  }
  const line = JSON.stringify(safe);
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}
