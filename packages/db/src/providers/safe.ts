const SECRET_KEY = /secret|password|token|authorization|api[_-]?key|pepper|private/i;
const SECRET_VALUE = /sk_live_|sk_test_|whsec_|Bearer\s+[A-Za-z0-9._-]+|isp_(?:test|live)_[A-Za-z0-9]+/i;

export function safePayloadSummary(payload: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!payload) {
    return out;
  }
  for (const [key, value] of Object.entries(payload)) {
    if (SECRET_KEY.test(key)) {
      continue;
    }
    if (typeof value === "string") {
      if (SECRET_VALUE.test(value)) {
        continue;
      }
      out[key] = value.length > 180 ? `${value.slice(0, 180)}…` : value;
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean" || value == null) {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = { count: value.length };
    }
  }
  return out;
}
