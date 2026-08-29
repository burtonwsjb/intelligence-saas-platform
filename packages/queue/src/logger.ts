const FORBIDDEN =
  /authorization|api[_-]?key|password|secret|token|bearer|redis:\/\/|rediss:\/\/|postgres(?:ql)?:\/\/|sk_live_|sk_test_|whsec_/i;

export function safeLoopErrorFields(error: unknown): {
  error_name: string;
  error_class: string;
} {
  const name = error instanceof Error ? error.name : "Error";
  const codeFrom = (value: unknown): string => {
    if (value && typeof value === "object" && "code" in value && typeof value.code === "string") {
      return value.code;
    }
    return "";
  };
  const code = codeFrom(error) || codeFrom(error instanceof Error ? error.cause : undefined);
  const errorClass =
    code === "42501"
      ? "permission_denied"
      : code === "25P02"
        ? "aborted_transaction"
        : code === "23502"
          ? "not_null_violation"
          : code === "23514"
            ? "check_violation"
            : code === "P0001"
              ? "raise_exception"
              : code || name.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64) || "unknown";
  return {
    error_name: name.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80) || "Error",
    error_class: errorClass,
  };
}

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
