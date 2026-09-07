import { describe, expect, it, vi } from "vitest";
import { createTccTransport, fetchTccCachedMarket, parseTccMarketBatch, tccMarketEndpoint,
  TCC_MARKET_PATH, TCC_RESPONSE_LIMIT, type TccMarketTarget } from "./tcc-cache-client.js";
import { ProviderHttpError } from "./transport.js";

const now = new Date("2026-09-07T05:00:00.000Z");
const env = { ISP_ENV: "staging", TCC_API_BASE_URL: "https://card-central-ai.lovable.app", TCC_API_TOKEN: "test_dedicated_token_abcdefghijklmnopqrstuvwxyz" };
export const target: TccMarketTarget = { canonicalSetKey: "sv1", request: {
  request_id: "printing_test", game_key: "pokemon", language_code: "en", card_name: "Pikachu",
  set_name: "Scarlet & Violet", collector_number: "005/198", variant_key: "normal", condition: "nm",
  grading_company: null, grade_label: null, tcc_card_id: null,
} };
export function responseFor(targets: TccMarketTarget[] = [target]) {
  return { version: "tcc.market.v1", generated_at: now.toISOString(), results: targets.map((t) => ({
    request_id: t.request.request_id, status: "available", identity: { ...t.request, tcc_card_id: "tcc_public_5" },
    quote: { price: "42.50", currency: "USD", market_type: "reference_price", price_type: "reference", observed_at: "2026-09-07T01:00:00.000Z",
      source_key: "tcg_card_central", upstream_source: "tcgdex", source_reference: "https://www.tcgplayer.com/product/123" },
    cache: { hit: true, stale: false, price_date: "2026-09-07", fetched_at: "2026-09-07T01:00:00.000Z" }, error_class: null,
  })) };
}
const mock = (body = responseFor()) => ({ fetch: vi.fn(async () => ({ status: 200, headers: {}, bodyText: JSON.stringify(body) })) });

describe("TCC shared-cache API consumer", () => {
  it("makes exactly one authenticated bounded TCC call, without vendor keys or force refresh", async () => {
    const transport = mock();
    const result = await fetchTccCachedMarket([target], { env: { ...env, POKETRACE_API_KEY: "upstream_never_sent" }, transport, now });
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    const call = transport.fetch.mock.calls[0] as unknown as [string, { body: string; headers: Record<string, string> }];
    expect(call[0]).toBe(`${env.TCC_API_BASE_URL}${TCC_MARKET_PATH}`);
    expect(call[1].headers.authorization).toBe(`Bearer ${env.TCC_API_TOKEN}`);
    expect(JSON.parse(call[1].body)).toEqual({ version: "tcc.market.v1", requests: [target.request] });
    expect(call[1].body).not.toMatch(/force|upstream_never_sent/);
    expect(result.records[0]).toMatchObject({ provider: "tcg_card_central", market_type: "market_price", price_type: "reference", price: 42.5,
      observed_at: "2026-09-07T01:00:00.000Z", printing: { set: "sv1", collector_number: "005/198", language: "en", variant: "normal" } });
    expect(result.records[0]?.sales_count).toBeUndefined();
    expect(result.records[0]?.volume_value).toBeUndefined();
  });
  it("dedupes cache hit/miss deliveries by original observation, not fetch time or price", () => {
    const body = responseFor(); const first = parseTccMarketBatch(body, [target], now).records[0]!;
    body.results[0]!.cache.hit = false; body.generated_at = "2026-09-07T05:01:00.000Z";
    const second = parseTccMarketBatch(body, [target], now).records[0]!;
    expect(second.provider_record_id).toBe(first.provider_record_id);
    body.results[0]!.quote.price = "43.50";
    expect(parseTccMarketBatch(body, [target], now).records[0]!.provider_record_id).toBe(first.provider_record_id);
  });
  it("keeps stale timestamps and marks them stale even if the peer incorrectly claims fresh", () => {
    const body = responseFor();
    body.results[0]!.quote.observed_at = "2026-09-06T01:00:00.000Z";
    body.results[0]!.cache.fetched_at = "2026-09-06T01:00:00.000Z"; body.results[0]!.cache.price_date = "2026-09-06";
    const result = parseTccMarketBatch(body, [target], now);
    expect(result.staleQuotes).toBe(1);
    expect(result.records[0]?.observed_at).toBe("2026-09-06T01:00:00.000Z");
    expect(result.records[0]?.attributes?.cache_stale).toBe(true);
  });
  it.each(["language_code", "collector_number", "variant_key", "condition", "grading_company", "grade_label", "game_key", "card_name", "set_name"])("rejects a conflicting %s", (key) => {
    const body = responseFor(); (body.results[0]!.identity as Record<string, unknown>)[key] = "different";
    expect(() => parseTccMarketBatch(body, [target], now)).toThrow();
  });
  it("rejects an external ID mismatch and never guesses when a quote is unavailable", () => {
    const fixed = { ...target, request: { ...target.request, tcc_card_id: "expected_id" } };
    expect(() => parseTccMarketBatch(responseFor([fixed]), [fixed], now)).toThrow();
    for (const status of ["not_found", "unavailable", "refresh_pending", "unsupported", "identity_mismatch"]) {
      const body = responseFor(); const row = body.results[0]!;
      Object.assign(row, { status, quote: null, error_class: "SECRET_FROM_REMOTE" });
      const report = parseTccMarketBatch(body, [target], now);
      expect(report.records).toEqual([]);
      expect(JSON.stringify(report)).not.toContain("SECRET_FROM_REMOTE");
    }
  });
  it.each(["0", "-1", "NaN", "1e3", "12,000", "1.234567891", "9007199254740993"])("rejects invalid or lossy major money %s", (price) => {
    const body = responseFor(); body.results[0]!.quote.price = price;
    expect(() => parseTccMarketBatch(body, [target], now)).toThrow();
  });
  it("rejects wrong price type/currency, future time and contradictory cache dates", () => {
    for (const patch of [{ currency: "JPY" }, { price_type: "sold" }, { market_type: "marketplace_sold" }, { observed_at: "2027-01-01T00:00:00Z" }]) {
      const body = responseFor(); Object.assign(body.results[0]!.quote, patch);
      expect(() => parseTccMarketBatch(body, [target], now)).toThrow();
    }
    const body = responseFor(); body.results[0]!.cache.price_date = "2026-01-01";
    expect(() => parseTccMarketBatch(body, [target], now)).toThrow();
  });
  it("rejects duplicate/foreign/missing IDs before returning a partial batch", () => {
    const second = { ...target, request: { ...target.request, request_id: "second" } };
    const body = responseFor([target, second]); body.results[1]!.request_id = target.request.request_id;
    expect(() => parseTccMarketBatch(body, [target, second], now)).toThrow();
    expect(() => parseTccMarketBatch(responseFor(), [target, second], now)).toThrow();
    const foreign = responseFor(); foreign.results[0]!.request_id = "foreign";
    expect(() => parseTccMarketBatch(foreign, [target], now)).toThrow();
  });
  it("refuses invalid origin, credential, oversize/unknown request fields before HTTP", async () => {
    for (const TCC_API_BASE_URL of ["http://card-central-ai.lovable.app", "https://api.poketrace.com", "https://localhost", "https://card-central-ai.lovable.app.evil.test", "https://user:pass@card-central-ai.lovable.app", "https://card-central-ai.lovable.app?key=x", "https://card-central-ai.lovable.app/other"]) {
      const transport = mock();
      await expect(fetchTccCachedMarket([target], { env: { ...env, TCC_API_BASE_URL }, transport })).rejects.toThrow();
      expect(transport.fetch).not.toHaveBeenCalled();
    }
    const transport = mock();
    await expect(fetchTccCachedMarket([target], { env: { ...env, TCC_API_TOKEN: "short" }, transport })).rejects.toThrow();
    await expect(fetchTccCachedMarket(Array.from({ length: 11 }, () => target), { env, transport })).rejects.toThrow();
    await expect(fetchTccCachedMarket([{ ...target, request: { ...target.request, forceRefresh: true } } as never], { env, transport })).rejects.toThrow();
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(() => tccMarketEndpoint({ ...env, ISP_ENV: "production", TCC_API_BASE_URL: "https://id-preview--e5087ef6-d3bb-4311-9659-ce63e24b9935.lovable.app" })).toThrow();
  });
  it("bounds timeouts, body size, rate limits and secret-bearing errors with no fallback", async () => {
    const never = vi.fn(() => new Promise<never>(() => undefined));
    await expect(fetchTccCachedMarket([target], { env, transport: { fetch: never }, timeoutMs: 5 })).rejects.toMatchObject({ errorClass: "timeout" });
    expect(never).toHaveBeenCalledTimes(1);
    const fetch = vi.fn(async () => ({ status: 429, headers: { "retry-after": "120" }, bodyText: env.TCC_API_TOKEN }));
    await expect(fetchTccCachedMarket([target], { env, transport: { fetch } })).rejects.toMatchObject({ errorClass: "rate_limited", retryAfterMs: 120_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(fetchTccCachedMarket([target], { env, transport: { fetch: async () => { throw new ProviderHttpError({ status: 500, errorClass: env.TCC_API_TOKEN, message: env.TCC_API_TOKEN }); } } })).rejects.toThrow("tcc_invalid_or_unavailable");
    await expect(fetchTccCachedMarket([target], { env, transport: { fetch: async () => ({ status: 200, headers: {}, bodyText: "x".repeat(TCC_RESPONSE_LIMIT + 1) }) } })).rejects.toMatchObject({ errorClass: "tcc_response_too_large" });
  });
  it("the real HTTP transport refuses redirects and caps the response stream", async () => {
    const fetch = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
      expect(init?.redirect).toBe("error");
      return new Response(JSON.stringify(responseFor()), { headers: { "content-type": "application/json" } });
    });
    const transport = createTccTransport(fetch as typeof globalThis.fetch);
    expect((await fetchTccCachedMarket([target], { env, transport, now })).records).toHaveLength(1);
    const large = createTccTransport(async () => new Response("x".repeat(TCC_RESPONSE_LIMIT + 1), { headers: { "content-type": "application/json" } }));
    await expect(fetchTccCachedMarket([target], { env, transport: large })).rejects.toMatchObject({ errorClass: "tcc_response_too_large" });
  });
  it("drops unsafe source links instead of propagating credentials", () => {
    const body = responseFor(); body.results[0]!.quote.source_reference = "https://www.tcgplayer.com/product/1?access_token=PRIVATE";
    expect(parseTccMarketBatch(body, [target], now).records[0]!.source_reference).toBeNull();
  });
});
