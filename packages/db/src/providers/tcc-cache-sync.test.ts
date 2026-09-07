import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";
import { readMigrationSql } from "../migrations.js";
import type { Database } from "../client.js";
import { withPlatformContext } from "../rls.js";
import { tcgGame, tcgLanguage, tcgSet, tcgCardConcept, tcgPrinting } from "../schema/tcg.js";
import { providerRuntime, providerSyncRun, platformOutbox } from "../schema/provider.js";
import { tcgMarketIngest, tcgMarketSnapshot } from "../schema/tcg-market.js";
import { normalizeTcgMarketIngest } from "../tcg/market-ingest.js";
import { applyProviderModeFromEnv, getProviderRuntime, setProviderControl } from "./runtime.js";
import { selectTccMarketTargets, syncTccCachedMarket } from "./tcc-cache-sync.js";
import { syncProvider } from "./sync.js";
import type { TccMarketRequest } from "./tcc-cache-client.js";

const env = { ISP_ENV: "staging", PROVIDER_TCG_CARD_CENTRAL_MODE: "live", TCC_API_BASE_URL: "https://card-central-ai.lovable.app", TCC_API_TOKEN: "dedicated_TCC_test_integration_token_12345678" };
const makeBody = (requests: TccMarketRequest[], status = "available", at = new Date()) => ({
  version: "tcc.market.v1", generated_at: at.toISOString(), results: requests.map((request) => ({
    request_id: request.request_id, status, identity: { ...request, tcc_card_id: `public_${request.request_id}` },
    quote: status !== "available" ? null : { price: "42.50", currency: "USD", price_type: "reference", market_type: "reference_price",
      observed_at: at.toISOString(), source_key: "tcg_card_central", upstream_source: "tcgdex", source_reference: null },
    cache: { hit: true, stale: false, price_date: at.toISOString().slice(0, 10), fetched_at: at.toISOString() }, error_class: null,
  })),
});

describe("TCC cache-first canonical ingestion", () => {
  let client: PGlite; let db: Database;
  const observed = new Date(Date.now() - 1000);
  beforeAll(async () => {
    client = new PGlite(); await client.exec(await readMigrationSql()); db = drizzle(client) as unknown as Database;
    await db.insert(tcgGame).values({ gameKey: "pokemon", displayName: "Pokemon" }).onConflictDoNothing();
    await db.insert(tcgLanguage).values({ languageCode: "en", displayName: "English" }).onConflictDoNothing();
    await db.insert(tcgSet).values({ id: "tcc_test_set", gameKey: "pokemon", canonicalSetKey: "tcc_test", name: "Test set" });
    await db.insert(tcgCardConcept).values({ id: "tcc_test_card", gameKey: "pokemon", conceptKey: "pikachu_tcc", canonicalName: "Pikachu", normalizedName: "Pikachu" });
    await db.insert(tcgPrinting).values(["a", "b", "c"].map((id, i) => ({
      id: `tcc_test_${id}`, cardId: "tcc_test_card", setId: "tcc_test_set", gameKey: "pokemon", collectorNumber: `00${i + 1}/198`,
      collectorNumberNormalized: `00${i + 1}/198`, languageCode: "en", variantKey: "normal", canonicalPrintingKey: `tcg:pokemon:pikachu_tcc:tcc_test:00${i + 1}/198:en:normal`,
    })));
  }, 30_000);
  afterAll(async () => { await client?.close(); });

  it("requires explicit live mode AND operator enablement, never credentials alone", async () => {
    const fetch = vi.fn();
    expect((await syncTccCachedMarket(db, { trigger: "schedule", env: { ...env, PROVIDER_TCG_CARD_CENTRAL_MODE: "disabled" }, transport: { fetch } })).reason).toBe("not_live");
    await withPlatformContext(db, (tx) => applyProviderModeFromEnv(tx, { ...env, PROVIDER_TCG_CARD_CENTRAL_MODE: "disabled" }));
    expect((await syncTccCachedMarket(db, { trigger: "schedule", env, transport: { fetch } })).reason).toBe("paused_or_disabled");
    expect(fetch).not.toHaveBeenCalled();
    await withPlatformContext(db, (tx) => applyProviderModeFromEnv(tx, env));
  });
  it("selects exact public printings without seeds and records cache quote plus durable normalize job", async () => {
    const fetch = vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init!.body!);
      expect(body.requests).toHaveLength(1);
      expect(body.requests[0]).toMatchObject({ request_id: "tcc_test_a", collector_number: "001/198", condition: "nm", language_code: "en" });
      // This succeeds only because the network call is outside the acquisition transaction.
      await withPlatformContext(db, async (tx) => { await tx.execute(sql`select 1`); });
      return { status: 200, headers: {}, bodyText: JSON.stringify(makeBody(body.requests, "available", observed)) };
    });
    expect(await syncProvider(db, { providerKey: "tcg_card_central", trigger: "admin", limit: 1, env, transport: { fetch } })).toMatchObject({ status: "completed", received: 1 });
    const rows = await db.select().from(tcgMarketIngest);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ currency: "USD", price: 42.5, price_type: "reference", observed_at: observed.toISOString() });
    const jobs = await db.select().from(platformOutbox);
    expect(jobs).toHaveLength(1); expect(jobs[0]!.status).toBe("pending");
    expect(jobs[0]!.payload).toMatchObject({ job_type: "tcg.market.normalize.v1", market_ingest_id: rows[0]!.id });
    const run = await db.select().from(providerSyncRun);
    expect(run.at(-1)!.checkpoint).toMatchObject({ requested: 1, accepted_quotes: 1, cache_hits: 1 });
    expect((await getProviderRuntime(db, "tcg_card_central"))?.cursor).toMatchObject({ tcc_catalog_after: "tcc_test_a" });
  });
  it("dedupes repeat delivery and refuses a changed price for the same observation", async () => {
    const resetCursor = () => withPlatformContext(db, (tx) => tx.update(providerRuntime).set({ cursor: {} }).where(eq(providerRuntime.providerKey, "tcg_card_central")));
    let price = "42.50";
    const fetch = vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = makeBody(JSON.parse(init!.body!).requests, "available", observed);
      body.results[0]!.quote!.price = price;
      return { status: 200, headers: {}, bodyText: JSON.stringify(body) };
    });
    await resetCursor();
    expect(await syncTccCachedMarket(db, { trigger: "admin", limit: 1, env, transport: { fetch } })).toMatchObject({ status: "completed", received: 0 });
    expect(await db.select().from(tcgMarketIngest)).toHaveLength(1);
    expect(await db.select().from(platformOutbox)).toHaveLength(1);
    await resetCursor(); price = "99.50";
    expect(await syncTccCachedMarket(db, { trigger: "admin", limit: 1, env, transport: { fetch } })).toMatchObject({ status: "failed", reason: "tcc_observation_conflict" });
    expect((await db.select().from(tcgMarketIngest))[0]!.payload.price).toBe(42.5);
  });
  it("normalizes the reference against the exact printing and skips today's stored quote", async () => {
    const [ingest] = await db.select().from(tcgMarketIngest);
    await withPlatformContext(db, (tx) => normalizeTcgMarketIngest(tx, ingest!.id));
    const rows = await db.select().from(tcgMarketSnapshot);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ printingId: "tcc_test_a", priceType: "reference", currency: "USD", condition: "nm" });
    const due = await selectTccMarketTargets(db, 10);
    expect(due.map((entry) => entry.request.request_id)).toEqual(["tcc_test_b", "tcc_test_c"]);
  });
  it("rotates past unsupported identities without marking the feed healthy or creating fake prices", async () => {
    const fetch = vi.fn(async (_url: string, init?: { body?: string }) => ({ status: 200, headers: {}, bodyText: JSON.stringify(makeBody(JSON.parse(init!.body!).requests, "unsupported")) }));
    const before = await db.select().from(tcgMarketIngest);
    expect(await syncTccCachedMarket(db, { trigger: "schedule", limit: 1, env, transport: { fetch } })).toMatchObject({ status: "skipped", reason: "no_available_quotes", received: 0 });
    const runtime = await getProviderRuntime(db, "tcg_card_central");
    expect(runtime?.cursor).toMatchObject({ tcc_catalog_after: "tcc_test_b" });
    expect(runtime?.healthStatus).toBe("unknown");
    expect(await db.select().from(tcgMarketIngest)).toHaveLength(before.length);
  });
  it("rejects mismatched remote identity before any ingest and releases the provider lease", async () => {
    const fetch = vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = makeBody(JSON.parse(init!.body!).requests); body.results[0]!.identity.language_code = "ja";
      return { status: 200, headers: {}, bodyText: JSON.stringify(body) };
    });
    expect(await syncTccCachedMarket(db, { trigger: "schedule", limit: 1, env, transport: { fetch } })).toMatchObject({ status: "failed", reason: "tcc_identity_mismatch", received: 0 });
    const runtime = await getProviderRuntime(db, "tcg_card_central");
    expect(runtime?.leaseUntil).toBeNull(); expect(runtime?.healthStatus).toBe("failed");
    expect(await db.select().from(tcgMarketIngest)).toHaveLength(1);
  });
  it("honors a pause while the external cache resolver is in flight", async () => {
    const fetch = vi.fn(async (_url: string, init?: { body?: string }) => {
      await withPlatformContext(db, (tx) => setProviderControl(tx, { providerKey: "tcg_card_central", paused: true }));
      return { status: 200, headers: {}, bodyText: JSON.stringify(makeBody(JSON.parse(init!.body!).requests)) };
    });
    expect(await syncTccCachedMarket(db, { trigger: "schedule", limit: 1, env, transport: { fetch } })).toMatchObject({ status: "skipped", reason: "operator_paused" });
    expect(await db.select().from(tcgMarketIngest)).toHaveLength(1);
    await withPlatformContext(db, (tx) => setProviderControl(tx, { providerKey: "tcg_card_central", paused: false }));
  });
  it("persists a bounded throttle and does not retry on the next scheduler tick", async () => {
    const fetch = vi.fn(async () => ({ status: 429, headers: { "retry-after": "60" }, bodyText: "private upstream text" }));
    expect((await syncTccCachedMarket(db, { trigger: "schedule", env, transport: { fetch } })).reason).toBe("rate_limited");
    expect((await syncTccCachedMarket(db, { trigger: "schedule", env, transport: { fetch } })).reason).toBe("throttled");
    expect(fetch).toHaveBeenCalledTimes(1);
    const rows = await db.select().from(providerSyncRun).where(eq(providerSyncRun.providerKey, "tcg_card_central"));
    expect(JSON.stringify(rows)).not.toMatch(/private upstream|dedicated_TCC_test/);
    expect((await getProviderRuntime(db, "tcg_card_central"))?.leaseUntil).toBeNull();
    await withPlatformContext(db, (tx) => tx.update(providerRuntime).set({ retryAfterAt: null }).where(eq(providerRuntime.providerKey, "tcg_card_central")));
  });
});
