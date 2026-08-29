import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  analyzeSourceSentiment,
  applyProviderModeFromEnv,
  assertStagingSourceCommandAllowed,
  backoffMs,
  classifyHttpStatus,
  createLiveMarketProvider,
  credentialReadinessReport,
  formatStagingSourceSmokeReport,
  ingestTcgMarketRecord,
  listProviderRuntime,
  listTcgMarketQuarantine,
  normalizeMarketVendorPayload,
  normalizeRedditListing,
  normalizeYoutubeVideo,
  parseRetryAfterMs,
  parseStagingIngestArgs,
  processIntelligenceRecomputeJob,
  ProviderHttpError,
  readMigrationSql,
  receiveTcgMarketRecord,
  resolveEntity,
  resolveProviderMode,
  runStagingSourceSmoke,
  seedTcgIdentityFixtures,
  StagingSourceCommandError,
  syncProvider,
  tcgPrediction,
  type Database,
} from "../index.js";
import { createFetchTransport, requireOkJson } from "./transport.js";
import { LiveTcgMarketProvider } from "./live-market.js";
import { safePayloadSummary } from "./safe.js";

async function memoryDb() {
  const client = new PGlite();
  await client.exec(await readMigrationSql());
  return drizzle(client) as unknown as Database;
}

describe("provider mode and credentials", () => {
  it("never infers live mode from credential presence", () => {
    expect(
      resolveProviderMode("tcg_card_central", {
        ISP_ENV: "staging",
        TCC_API_TOKEN: "present",
        TCC_API_BASE_URL: "https://example.invalid",
      }),
    ).toBe("disabled");
    expect(resolveProviderMode("reddit", { NODE_ENV: "test" })).toBe("fixture");
    expect(resolveProviderMode("youtube", { ISP_ENV: "production", PROVIDER_YOUTUBE_MODE: "live" })).toBe("live");
  });

  it("reports credential names without values", () => {
    const report = credentialReadinessReport({
      TCC_API_TOKEN: "super-secret-token",
      ISP_ENV: "staging",
    });
    const blob = JSON.stringify(report);
    expect(blob).not.toMatch(/super-secret-token/);
    expect(report.some((row) => row.environment_variable === "TCC_API_TOKEN" && row.configured)).toBe(true);
  });
});

describe("staging command guards", () => {
  it("refuses production and requires staging", () => {
    expect(() => assertStagingSourceCommandAllowed({ ISP_ENV: "production" })).toThrow(StagingSourceCommandError);
    expect(() => assertStagingSourceCommandAllowed({ ISP_ENV: "local" })).toThrow(StagingSourceCommandError);
    expect(() => assertStagingSourceCommandAllowed({ ISP_ENV: "staging" })).not.toThrow();
    expect(parseStagingIngestArgs(["--provider", "reddit", "--limit", "3"])).toEqual({
      provider: "reddit",
      limit: 3,
    });
  });

  it("uses the platform admin connection and system principal path", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const staging = readFileSync(path.join(dir, "staging.ts"), "utf8");
    const cli = readFileSync(path.join(dir, "../staging-source-smoke.ts"), "utf8");
    expect(cli).toMatch(/requirePlatformAdminConnectionUrl/);
    expect(cli).not.toMatch(/requireDatabaseUrl\(/);
    expect(cli).not.toMatch(/APP_DATABASE_URL/);
    expect(staging).toMatch(/withPlatformContext/);
    expect(staging).not.toMatch(/current_principal_type', 'user'/);
  });

  it("bootstraps disabled provider runtime in staging mode without printing secrets", async () => {
    const db = await memoryDb();
    const env = {
      ISP_ENV: "staging",
      TCC_API_TOKEN: "super-secret-token",
      TCC_API_BASE_URL: "https://example.invalid",
    };
    const first = await runStagingSourceSmoke(db, env);
    expect(first.production_refused).toBe(false);
    expect(first.tenant_writes).toBe(0);
    expect(first.live_bounded_samples).toEqual([]);
    const tcc = first.providers.find((row) => row.provider === "tcg_card_central");
    expect(tcc).toMatchObject({
      type: "market",
      mode: "disabled",
      enabled: false,
      credential_status: "present",
    });
    const second = await runStagingSourceSmoke(db, env);
    expect(second.providers.map((row) => row.provider).sort()).toEqual(
      first.providers.map((row) => row.provider).sort(),
    );
    expect(second.providers.find((row) => row.provider === "tcg_card_central")?.mode).toBe("disabled");
    const report = formatStagingSourceSmokeReport(first);
    expect(report).not.toMatch(/super-secret-token/);
    expect(JSON.stringify(first)).not.toMatch(/super-secret-token/);
    expect(JSON.stringify(first.credentials)).not.toMatch(/super-secret-token/);
  });
});

describe("provider http transport", () => {
  it("classifies 429, 5xx, and timeouts with backoff", () => {
    expect(classifyHttpStatus(429)).toBe("rate_limited");
    expect(classifyHttpStatus(503)).toBe("upstream_5xx");
    expect(classifyHttpStatus(408)).toBe("timeout");
    expect(parseRetryAfterMs({ "retry-after": "2" })).toBe(2000);
    expect(backoffMs(1)).toBe(2000);
    expect(backoffMs(3)).toBe(8000);
  });

  it("does not retry immediately after 429", async () => {
    const transport = createFetchTransport({
      fetchImpl: async () =>
        new Response("nope", { status: 429, headers: { "retry-after": "12", "x-ratelimit-remaining": "0" } }),
    });
    const response = await transport.fetch("https://example.invalid/v1");
    expect(() => requireOkJson(response, () => ({}))).toThrow(ProviderHttpError);
    try {
      requireOkJson(response, () => ({}));
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderHttpError);
      expect((error as ProviderHttpError).retryAfterMs).toBe(12_000);
    }
  });
});

describe("vendor normalization", () => {
  it("normalizes TCC, Reddit, and YouTube payloads into canonical records", () => {
    const market = normalizeMarketVendorPayload("tcg_card_central", {
      id: "tcc_1",
      market_type: "marketplace_sold",
      observed_at: "2026-01-02T00:00:00.000Z",
      currency: "USD",
      condition: "nm",
      price: 41,
      printing: { game: "pokemon", set: "twm", collector_number: "214/167", language: "en", variant: "normal" },
    });
    expect(market.provider).toBe("tcg_card_central");
    expect(market.price).toBe(41);
    expect(market.attributes?.provenance).toMatchObject({ normalizer_version: "tcg.market.normalize.v1" });

    const reddit = normalizeRedditListing({
      data: {
        id: "abc12345",
        author: "card_person",
        title: "Pikachu is going crazy",
        selftext: "hype only",
        permalink: "/r/PokemonTCG/comments/abc12345/x/",
        created_utc: 1_767_312_000,
        score: 12,
        num_comments: 3,
      },
    });
    expect(reddit.provider).toBe("reddit");
    expect(reddit.content.canonical_url).toMatch(/^https:\/\//);

    const youtube = normalizeYoutubeVideo({
      id: "ytvid12345",
      snippet: {
        channelId: "UCabc",
        channelTitle: "Signals",
        title: "Market talk",
        publishedAt: "2026-01-02T00:00:00.000Z",
        description: "No transcript supplied",
      },
      statistics: { viewCount: "100", likeCount: "4", commentCount: "1" },
    });
    expect(youtube.content.transcript_available).toBe(false);
    expect(youtube.content.excerpt).toBeNull();
    expect(reddit.mentions?.[0]?.raw_entity_text).toBe("Pikachu is going crazy");
  });
});

describe("live adapters with mock transport", () => {
  it("maps live TCC JSON and stays null without credentials", async () => {
    expect(createLiveMarketProvider("tcg_card_central", {})).toBeNull();
    const provider = new LiveTcgMarketProvider({
      provider: "tcg_card_central",
      auth: { baseUrl: "https://tcc.example", token: "secret-token" },
      transport: {
        async fetch() {
          return {
            status: 200,
            headers: {},
            bodyText: JSON.stringify({
              items: [
                {
                  id: "snap_1",
                  market_type: "marketplace_sold",
                  observed_at: "2026-01-02T00:00:00.000Z",
                  currency: "USD",
                  condition: "nm",
                  price: 40,
                  printing: {
                    game: "pokemon",
                    set: "twm",
                    collector_number: "214/167",
                    language: "en",
                    variant: "normal",
                  },
                },
              ],
            }),
          };
        },
      },
    });
    const rows = await provider.getSoldTransactions({});
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toMatch(/secret-token/);
  });
});

describe("sentiment", () => {
  it("does not treat viral excitement as a buy signal", () => {
    const hype = analyzeSourceSentiment({ text: "Pikachu is going crazy this is fire" });
    expect(hype.excitement).toBe("present");
    expect(hype.purchase_intent).toBe("none");
    expect(hype.creator_recommendation).toBe("none");
    expect(hype.market_relevance).toBe("low");
    const buy = analyzeSourceSentiment({ text: "I would buy this, target $50" });
    expect(buy.purchase_intent).toBe("present");
    expect(buy.creator_recommendation).toBe("buy");
  });
});

describe("safe summaries", () => {
  it("strips secrets from quarantine summaries", () => {
    expect(
      safePayloadSummary({
        authorization: "Bearer aaa",
        price: 41,
        token: "x",
        title: "ok",
      }),
    ).toEqual({ price: 41, title: "ok" });
  });
});

describe("real ingest pipeline", () => {
  it("syncs fixture mode, dedupes, quarantines future timestamps, and keeps predictions shadow", async () => {
    const db = await memoryDb();
    const seeded = await seedTcgIdentityFixtures(db);
    await applyProviderModeFromEnv(db, { NODE_ENV: "test", PROVIDER_TCG_CARD_CENTRAL_MODE: "fixture" });
    const rows = await listProviderRuntime(db);
    expect(rows.find((row) => row.providerKey === "tcg_card_central")?.mode).toBe("fixture");

    const first = await syncProvider(db, {
      providerKey: "tcg_card_central",
      trigger: "admin",
      env: { NODE_ENV: "test", PROVIDER_TCG_CARD_CENTRAL_MODE: "fixture" },
    });
    expect(first.status).toBe("completed");
    const second = await syncProvider(db, {
      providerKey: "tcg_card_central",
      trigger: "admin",
      env: { NODE_ENV: "test", PROVIDER_TCG_CARD_CENTRAL_MODE: "fixture" },
    });
    expect(second.status).toBe("completed");

    const received = await receiveTcgMarketRecord(db, {
      provider: "tcg_card_central",
      provider_record_id: "future_ts_1",
      event_type: "tcg.market.sold",
      market_type: "marketplace_sold",
      observed_at: "2099-01-01T00:00:00.000Z",
      currency: "USD",
      condition: "nm",
      price: 40,
      printing: { game: "pokemon", set: "twm", collector_number: "214/167", language: "en", variant: "normal" },
    });
    const ingested = await ingestTcgMarketRecord(db, {
      provider: "tcg_card_central",
      provider_record_id: "future_ts_1",
      event_type: "tcg.market.sold",
      market_type: "marketplace_sold",
      observed_at: "2099-01-01T00:00:00.000Z",
      currency: "USD",
      condition: "nm",
      price: 40,
      printing: { game: "pokemon", set: "twm", collector_number: "214/167", language: "en", variant: "normal" },
    });
    expect(ingested.status).toBe("quarantined");
    expect((await listTcgMarketQuarantine(db)).some((row) => row.reason === "impossible_timestamp")).toBe(true);
    void received;

    const recomputed = await processIntelligenceRecomputeJob(db, {
      printingId: seeded.printings.greninjaEnNormal.id,
      asOf: new Date("2026-01-04T12:00:00.000Z"),
    });
    expect(recomputed.publishedPredictions).toBe(0);
    const published = await db.select().from(tcgPrediction);
    expect(published.every((row) => row.visibility === "shadow")).toBe(true);
  });

  it("skips disabled and live-without-credentials providers", async () => {
    const db = await memoryDb();
    const disabled = await syncProvider(db, {
      providerKey: "ebay",
      trigger: "schedule",
      env: { ISP_ENV: "staging" },
    });
    expect(disabled.status).toBe("skipped");
    const pending = await syncProvider(db, {
      providerKey: "youtube",
      trigger: "schedule",
      env: { ISP_ENV: "staging", PROVIDER_YOUTUBE_MODE: "live" },
    });
    expect(pending.reason).toBe("disabled_pending_credentials");
  });

  it("does not silently pick a printing from a name-only mention", async () => {
    const db = await memoryDb();
    const seeded = await seedTcgIdentityFixtures(db);
    const resolved = await resolveEntity(db, {
      subjectType: "manual",
      subjectId: "name_only_pikachu",
      signals: { game: "pokemon", card_name: "Pikachu", context_text: "Pikachu is going crazy" },
    });
    expect(resolved.attempt.chosenPrintingId).toBeNull();
    expect(resolved.attempt.status).not.toBe("exact");
    expect(resolved.attempt.chosenConceptId).toBe(seeded.concepts.pikachu.id);
  });
});
