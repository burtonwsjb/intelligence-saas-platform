import { createHash } from "node:crypto";
import { moneyToFiniteNumber, persistMoneyDecimal } from "@isp/shared";
import { parseTcgMarketRecord, type TcgMarketRecordInput } from "../tcg/market-identity.js";
import { classifyHttpStatus, parseRetryAfterMs, ProviderHttpError, type HttpTransport, type HttpResponse } from "./transport.js";

export const TCC_MARKET_VERSION = "tcc.market.v1";
export const TCC_MARKET_PATH = "/api/integrations/social-signal-iq/market";
export const TCC_BATCH_LIMIT = 10;
export const TCC_BODY_LIMIT = 16_384;
export const TCC_RESPONSE_LIMIT = 131_072;
export const TCC_TIMEOUT_MS = 20_000;
const STATUS = ["available", "not_found", "refresh_pending", "unavailable", "unsupported", "identity_mismatch"] as const;
type TccStatus = typeof STATUS[number];

/** Exact public-catalog identity, never a tenant collection or a name-only hint. */
export type TccMarketRequest = {
  request_id: string;
  game_key: string;
  language_code: string;
  card_name: string;
  set_name: string;
  collector_number: string;
  variant_key: string;
  condition: string;
  grading_company: string | null;
  grade_label: string | null;
  tcc_card_id: string | null;
};
export type TccMarketTarget = { request: TccMarketRequest; canonicalSetKey: string };
export type TccBatchReport = {
  records: TcgMarketRecordInput[];
  statuses: Record<TccStatus, number>;
  cacheHits: number;
  staleQuotes: number;
};

function failure(errorClass = "invalid_payload", status = 0): ProviderHttpError {
  return new ProviderHttpError({ errorClass, status });
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || [...value].some((character) => character.charCodeAt(0) < 32)) throw failure();
  return value;
}
function nullableText(value: unknown, max = 256): string | null {
  return value === null ? null : text(value, max);
}
function instant(value: unknown): string {
  const result = text(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(result) || !Number.isFinite(Date.parse(result))) throw failure();
  return new Date(result).toISOString();
}
const nameKey = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

/** Credentials may only be sent to the owner's TCC origins, never a vendor or arbitrary URL. */
export function tccMarketEndpoint(env: NodeJS.ProcessEnv): string {
  let base: URL;
  try { base = new URL(env.TCC_API_BASE_URL?.trim() ?? ""); } catch { throw failure("tcc_configuration"); }
  const origins = new Set(["https://tcgcardcentral.com", "https://www.tcgcardcentral.com", "https://card-central-ai.lovable.app"]);
  if (env.ISP_ENV !== "production") origins.add("https://id-preview--e5087ef6-d3bb-4311-9659-ce63e24b9935.lovable.app");
  if (!origins.has(base.origin) || base.username || base.password || base.pathname !== "/" || base.search || base.hash) throw failure("tcc_configuration");
  return new URL(TCC_MARKET_PATH, base).href;
}
function validateTargets(targets: readonly TccMarketTarget[]): void {
  if (targets.length < 1 || targets.length > TCC_BATCH_LIMIT) throw failure("tcc_request_invalid");
  const ids = new Set<string>();
  const keys = ["request_id", "game_key", "language_code", "card_name", "set_name", "collector_number", "variant_key", "condition", "grading_company", "grade_label", "tcc_card_id"];
  for (const target of targets) {
    const req = object(target.request);
    if (Object.keys(req).some((key) => !keys.includes(key)) || keys.some((key) => !(key in req))) throw failure("tcc_request_invalid");
    for (const key of keys.slice(0, 8)) text(req[key], key === "request_id" ? 128 : 256);
    for (const key of keys.slice(8)) nullableText(req[key]);
    text(target.canonicalSetKey);
    if (ids.has(target.request.request_id) || Boolean(req.grading_company) !== Boolean(req.grade_label)) throw failure("tcc_request_invalid");
    ids.add(target.request.request_id);
  }
}
function sourceReference(value: unknown): string | null {
  if (value === null) return null;
  const raw = text(value, 2048);
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  const host = url.hostname.toLowerCase();
  const trusted = ["tcgplayer.com", "tcgcardcentral.com", "poketrace.com", "tcgdex.net", "pokemontcg.io"];
  if (url.protocol !== "https:" || url.username || url.password || !trusted.some((domain) => host === domain || host.endsWith(`.${domain}`))) return null;
  if ([...url.searchParams.keys()].some((key) => /token|key|secret|auth|password/i.test(key))) return null;
  return url.href;
}

/** Validate the complete batch before any ingest. Server cache metadata never rewrites observation time. */
export function parseTccMarketBatch(value: unknown, targets: readonly TccMarketTarget[], now = new Date()): TccBatchReport {
  validateTargets(targets);
  const root = object(value);
  if (root.version !== TCC_MARKET_VERSION || !Array.isArray(root.results) || root.results.length !== targets.length) throw failure();
  instant(root.generated_at);
  const byId = new Map(targets.map((target) => [target.request.request_id, target]));
  const statuses = Object.fromEntries(STATUS.map((status) => [status, 0])) as Record<TccStatus, number>;
  const report: TccBatchReport = { records: [], statuses, cacheHits: 0, staleQuotes: 0 };
  for (const value of root.results) {
    const row = object(value);
    const id = text(row.request_id, 128);
    const target = byId.get(id);
    if (!target || !STATUS.includes(row.status as TccStatus)) throw failure();
    byId.delete(id);
    const status = row.status as TccStatus;
    statuses[status] += 1;
    if (status !== "available") {
      if (row.quote !== null) throw failure();
      continue; // Fixed statuses only. Never persist remote free-text error messages.
    }
    if (row.error_class !== null) throw failure();
    const identity = object(row.identity);
    const request = target.request;
    for (const key of ["game_key", "language_code", "collector_number", "variant_key", "condition", "grading_company", "grade_label"] as const) {
      if (identity[key] !== request[key]) throw failure("tcc_identity_mismatch");
    }
    for (const key of ["card_name", "set_name"] as const) {
      if (nameKey(text(identity[key])) !== nameKey(request[key])) throw failure("tcc_identity_mismatch");
    }
    const externalId = nullableText(identity.tcc_card_id);
    if (request.tcc_card_id && request.tcc_card_id !== externalId) throw failure("tcc_identity_mismatch");
    const quote = object(row.quote);
    const cache = object(row.cache);
    if (quote.currency !== "USD" || quote.price_type !== "reference" || quote.market_type !== "reference_price" || quote.source_key !== "tcg_card_central") throw failure();
    if (typeof cache.hit !== "boolean" || typeof cache.stale !== "boolean") throw failure();
    const observedAt = instant(quote.observed_at);
    const fetchedAt = instant(cache.fetched_at);
    const priceDate = text(cache.price_date, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(priceDate) || priceDate !== fetchedAt.slice(0, 10) || Date.parse(observedAt) > Date.parse(fetchedAt) || Date.parse(fetchedAt) > now.getTime() + 300_000) throw failure();
    const stale = cache.stale || priceDate < now.toISOString().slice(0, 10);
    // Preserve major units without accepting exponent notation, zero, negative values or precision loss.
    const decimal = persistMoneyDecimal(text(quote.price, 24));
    const amount = moneyToFiniteNumber(decimal);
    if (amount <= 0 || persistMoneyDecimal(amount) !== decimal) throw failure();
    const upstream = nullableText(quote.upstream_source, 80);
    const knownSource = upstream && ["tcgcsv", "pokemontcg.io", "tcgdex", "poketrace", "justtcg", "optcg", "cache"].includes(upstream) ? upstream : null;
    // Cache-hit flags, delivery time and price itself are deliberately absent from identity:
    // same observation dedupes; a changed price at the same time becomes a revision conflict.
    const fingerprint = createHash("sha256").update(JSON.stringify([
      request.game_key, target.canonicalSetKey, request.collector_number, request.language_code,
      request.variant_key, request.condition, request.grading_company, request.grade_label, observedAt, "USD", "reference",
    ])).digest("hex");
    report.records.push(parseTcgMarketRecord({
      provider: "tcg_card_central", provider_record_id: `tcc_cache_${fingerprint}`,
      event_type: "tcg.market.reference_price", market_type: "market_price", price_type: "reference",
      observed_at: observedAt, currency: "USD", condition: request.condition,
      grading_company: request.grading_company, grade_label: request.grade_label, price: amount,
      printing: { game: request.game_key, set: target.canonicalSetKey, collector_number: request.collector_number, language: request.language_code, variant: request.variant_key },
      source_reference: sourceReference(quote.source_reference), aggregation_kind: "event",
      attributes: { integration: TCC_MARKET_VERSION, tcc_card_id: externalId, upstream_source: knownSource,
        cache_hit: cache.hit, cache_stale: stale, price_date: priceDate, fetched_at: fetchedAt },
    }));
    if (cache.hit) report.cacheHits += 1;
    if (stale) report.staleQuotes += 1;
  }
  return report;
}

/** A dedicated transport: bounded response, one request, no redirect/token forwarding and no vendor fallback. */
export function createTccTransport(fetchImpl: typeof fetch = fetch): HttpTransport {
  return { async fetch(url, init): Promise<HttpResponse> {
    const response = await fetchImpl(url, { method: "POST", headers: init?.headers, body: init?.body,
      redirect: "error", signal: init?.signal });
    if (response.status !== 200) {
      await response.body?.cancel();
      return { status: response.status, headers: { "retry-after": response.headers.get("retry-after") ?? "" }, bodyText: "" };
    }
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      await response.body?.cancel(); throw failure();
    }
    const reader = response.body?.getReader();
    if (!reader) throw failure();
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > TCC_RESPONSE_LIMIT) throw failure("tcc_response_too_large");
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    return { status: response.status, headers: {}, bodyText: Buffer.concat(chunks).toString("utf8") };
  } };
}

export async function fetchTccCachedMarket(targets: readonly TccMarketTarget[], input: {
  env?: NodeJS.ProcessEnv; transport?: HttpTransport; now?: Date; timeoutMs?: number;
} = {}): Promise<TccBatchReport> {
  const env = input.env ?? process.env;
  try {
    validateTargets(targets);
    const endpoint = tccMarketEndpoint(env);
    const token = env.TCC_API_TOKEN?.trim() ?? "";
    if (token.length < 32 || token.length > 512 || /[^\x21-\x7e]/.test(token)) throw failure("tcc_configuration");
    const body = JSON.stringify({ version: TCC_MARKET_VERSION, requests: targets.map((target) => target.request) });
    if (Buffer.byteLength(body) > TCC_BODY_LIMIT) throw failure("tcc_request_invalid");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        (input.transport ?? createTccTransport()).fetch(endpoint, { method: "POST", headers: {
          authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json",
        }, body, signal: controller.signal }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure("timeout", 408)); }, input.timeoutMs ?? TCC_TIMEOUT_MS); }),
      ]);
      if (response.status !== 200) throw new ProviderHttpError({ status: response.status,
        errorClass: response.status >= 300 && response.status < 400 ? "tcc_redirect_refused" : classifyHttpStatus(response.status) === "ok" ? "tcc_unexpected_status" : classifyHttpStatus(response.status),
        retryAfterMs: response.status === 429 ? parseRetryAfterMs(response.headers) : null });
      if (Buffer.byteLength(response.bodyText) > TCC_RESPONSE_LIMIT) throw failure("tcc_response_too_large");
      let parsed: unknown;
      try { parsed = JSON.parse(response.bodyText); } catch { throw failure(); }
      return parseTccMarketBatch(parsed, targets, input.now);
    } finally { if (timer) clearTimeout(timer); }
  } catch (error) {
    // Fixed classifications only, including malicious provider text and underlying network exceptions.
    if (error instanceof ProviderHttpError) {
      const allowed = ["invalid_payload", "tcc_configuration", "tcc_request_invalid", "tcc_identity_mismatch", "tcc_response_too_large",
        "tcc_redirect_refused", "tcc_unexpected_status", "timeout", "auth", "not_found", "rate_limited", "upstream_5xx", "upstream_4xx", "network"];
      throw new ProviderHttpError({ status: error.status, errorClass: allowed.includes(error.errorClass) ? error.errorClass : "tcc_invalid_or_unavailable",
        retryAfterMs: error.retryAfterMs });
    }
    throw failure("tcc_invalid_or_unavailable");
  }
}
