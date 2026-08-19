const FORBIDDEN = /authorization|api[_-]?key|password|secret|redis:\/\/[^@]+@|postgresql:\/\/[^@]+@/i;

export function logQueueEvent(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, string | number | boolean | null | undefined>,
): void {
  const safe: Record<string, string | number | boolean | null> = { event };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }
    if (typeof value === "string" && FORBIDDEN.test(value)) {
      continue;
    }
    if (FORBIDDEN.test(key)) {
      continue;
    }
    safe[key] = value;
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
