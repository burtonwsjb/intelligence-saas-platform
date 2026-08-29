export type HttpHeaders = Record<string, string>;

export type HttpResponse = {
  status: number;
  headers: HttpHeaders;
  bodyText: string;
};

export type HttpTransport = {
  fetch(url: string, init?: { method?: string; headers?: HttpHeaders; body?: string; signal?: AbortSignal }): Promise<HttpResponse>;
};

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly errorClass: string;
  readonly retryAfterMs: number | null;

  constructor(input: { status: number; errorClass: string; retryAfterMs?: number | null; message?: string }) {
    super(input.message ?? input.errorClass);
    this.name = "ProviderHttpError";
    this.status = input.status;
    this.errorClass = input.errorClass;
    this.retryAfterMs = input.retryAfterMs ?? null;
  }
}

export function classifyHttpStatus(status: number): string {
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 404) {
    return "not_found";
  }
  if (status === 408) {
    return "timeout";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status >= 500) {
    return "upstream_5xx";
  }
  if (status >= 400) {
    return "upstream_4xx";
  }
  return "ok";
}

export function parseRetryAfterMs(headers: HttpHeaders, fallbackMs = 60_000): number {
  const raw = headers["retry-after"] ?? headers["Retry-After"] ?? "";
  if (!raw) {
    return fallbackMs;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1000), 15 * 60_000);
  }
  const when = Date.parse(raw);
  if (Number.isFinite(when)) {
    return Math.min(Math.max(0, when - Date.now()), 15 * 60_000);
  }
  return fallbackMs;
}

export function parseRateLimitHeaders(headers: HttpHeaders): {
  remaining: number | null;
  resetAt: Date | null;
} {
  const remainingRaw = headers["x-ratelimit-remaining"] ?? headers["X-RateLimit-Remaining"];
  const resetRaw = headers["x-ratelimit-reset"] ?? headers["X-RateLimit-Reset"];
  const remaining = remainingRaw != null && remainingRaw !== "" ? Number(remainingRaw) : null;
  let resetAt: Date | null = null;
  if (resetRaw) {
    const asNumber = Number(resetRaw);
    if (Number.isFinite(asNumber)) {
      resetAt = new Date(asNumber > 1_000_000_000_000 ? asNumber : asNumber * 1000);
    }
  }
  return {
    remaining: remaining != null && Number.isFinite(remaining) ? remaining : null,
    resetAt,
  };
}

export function createFetchTransport(input?: { timeoutMs?: number; fetchImpl?: typeof fetch }): HttpTransport {
  const timeoutMs = input?.timeoutMs ?? 10_000;
  const fetchImpl = input?.fetchImpl ?? fetch;
  return {
    async fetch(url, init) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: init?.method ?? "GET",
          headers: init?.headers,
          body: init?.body,
          signal: init?.signal ?? controller.signal,
        });
        const headers: HttpHeaders = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        return {
          status: response.status,
          headers,
          bodyText: await response.text(),
        };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new ProviderHttpError({ status: 408, errorClass: "timeout", message: "Provider request timed out." });
        }
        throw new ProviderHttpError({
          status: 0,
          errorClass: "network",
          message: "Provider network request failed.",
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function requireOkJson<T>(response: HttpResponse, parse: (value: unknown) => T): T {
  const errorClass = classifyHttpStatus(response.status);
  if (errorClass !== "ok") {
    throw new ProviderHttpError({
      status: response.status,
      errorClass,
      retryAfterMs: response.status === 429 ? parseRetryAfterMs(response.headers) : null,
    });
  }
  let parsed: unknown;
  try {
    parsed = response.bodyText ? JSON.parse(response.bodyText) : {};
  } catch {
    throw new ProviderHttpError({ status: response.status, errorClass: "invalid_payload" });
  }
  return parse(parsed);
}

export function backoffMs(attempt: number, baseMs = 2_000, capMs = 60_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return exp;
}

export function redactProviderUrl(url: string): string {
  return url.replace(/([?&](key|token|access_token|api_key)=)[^&]+/gi, "$1[redacted]");
}
