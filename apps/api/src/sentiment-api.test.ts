import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { generateApiKeySecret } from "@isp/auth";
import {
  ingestSourceContentRecord,
  insertApiKey,
  member,
  organization,
  readMigrationSql,
  recordUsage,
  runChartSentimentBatch,
  seedTcgIdentityFixtures,
  setCreatorPreference,
  syncSealedProducts,
  tenant,
  tenantBilling,
  user,
  withOrganizationContext,
  type Database,
} from "@isp/db";
import { createApiApp } from "./app.js";

const pepper = "sentiment-api-test-pepper";

async function seedKey(db: Database, scopes: string) {
  const generated = generateApiKeySecret(pepper);
  await db.insert(user).values({ id: "u_api", name: "U", email: "u_api@example.com", emailVerified: true });
  await db.insert(organization).values({ id: "o_api", name: "o_api", slug: "o-api" });
  await db.insert(member).values({ id: "m_api", organizationId: "o_api", userId: "u_api", role: "owner" });
  await db.insert(tenant).values({ organizationId: "o_api", status: "active", createdByUserId: "u_api" });
  await db.insert(tenantBilling).values({ organizationId: "o_api", planKey: "free", status: "none" });
  await withOrganizationContext(db, { organizationId: "o_api", userId: "u_api" }, (scoped) =>
    insertApiKey(scoped, {
      id: "key_api",
      organizationId: "o_api",
      name: "test",
      prefix: generated.prefix,
      secretHash: generated.secretHash,
      scopes,
      createdByUserId: "u_api",
    }),
  );
  return generated.fullKey;
}

describe("sentiment API for cards and products", () => {
  it("serves card and product sentiment with history, and respects the workspace's hidden creators", async () => {
    const client = new PGlite();
    await client.exec(await readMigrationSql());
    const db = drizzle(client) as unknown as Database;
    const seeded = await seedTcgIdentityFixtures(db);
    await syncSealedProducts(db);
    const now = new Date();
    const recent = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    await ingestSourceContentRecord(db, {
      provider: "youtube",
      provider_record_id: "yt_api_1",
      event_type: "source.content.ingested",
      account: { external_account_id: "yt_api_ch", handle: "ApiCh", display_name: "Api Channel", canonical_url: "https://youtube.com/@apich" },
      content: {
        external_content_id: "yt_api_1",
        content_type: "video",
        published_at: recent,
        title: "Greninja is undervalued, buy",
        summary: "English Twilight Masquerade Greninja 214 normal will go up.",
        canonical_url: "https://youtube.com/watch?v=yt_api_1",
        language: "en",
        excerpt: "English Twilight Masquerade Greninja 214 normal will go up.",
      },
      segments: [{ kind: "timestamp_range", start_ref: "00:00:01", end_ref: "00:00:10", excerpt: "Greninja will go up" }],
      mentions: [
        {
          raw_entity_text: "English Twilight Masquerade Greninja 214 normal",
          mention_context: "recommendation",
          candidate_direction: "bullish",
          sentiment: "positive",
          segment_index: 0,
        },
      ],
    });
    await client.query(
      `INSERT INTO source_content (id, source_type, external_content_id, account_id, published_at, title, canonical_url, content_type, fingerprint)
       SELECT 'c_box_api', 'youtube', 'c_box_api', id, $1, 'Twilight Masquerade booster box will go up, buy', 'https://example.test/box', 'video', 'c_box_api'
       FROM source_account WHERE external_account_id = 'yt_api_ch'`,
      [recent],
    );

    // 80 days of a rising raw reference price and 40 days of PSA 10 sales for the chart.
    const day = 86_400_000;
    const chartStart = new Date(now.getTime() - 80 * day);
    await client.query(
      `INSERT INTO tcg_market_snapshot (id, printing_id, source_key, market_type, price_type, observed_at, currency, condition, price, source_record_id, fingerprint)
       SELECT 'chart_r' || g, $1, 'tcg_card_central', 'market_price', 'reference', $2::timestamptz + g * interval '1 day',
         'USD', 'nm', round((10 * power(1.005, g))::numeric, 2), 'chart_r' || g, 'chart_r' || g
       FROM generate_series(0, 79) g`,
      [seeded.printings.greninjaEnNormal.id, chartStart.toISOString()],
    );
    await client.query(
      `INSERT INTO tcg_market_snapshot (id, printing_id, source_key, market_type, price_type, observed_at, currency, condition,
         grading_company, grade_numeric, price, source_record_id, fingerprint)
       SELECT 'chart_g' || g, $1, 'ebay', 'marketplace_sold', 'sold', $2::timestamptz + g * interval '1 day', 'USD', 'nm',
         'psa', 10, 200, 'chart_g' || g, 'chart_g' || g
       FROM generate_series(0, 39) g`,
      [seeded.printings.greninjaEnNormal.id, new Date(now.getTime() - 40 * day).toISOString()],
    );
    expect(await runChartSentimentBatch(db, { asOf: now, batchSize: 10 })).toMatchObject({ printings: 1, segments: 2 });

    const key = await seedKey(db, "cards:read,signals:read");
    const app = createApiApp({ db, env: { API_KEY_PEPPER: pepper, NODE_ENV: "test" } });
    const auth = { authorization: `Bearer ${key}` };

    const card = await app.request(`/v1/printings/${seeded.printings.greninjaEnNormal.id}/sentiment?window=7d`, { headers: auth });
    expect(card.status).toBe(200);
    const cardBody = (await card.json()) as {
      sentiment: { posts: number; counts: { positive: number }; shares: { positive: number } };
      history: { period_days: number; points: unknown[] };
      calls: { total: number };
    };
    expect(cardBody.sentiment.counts.positive).toBe(1);
    expect(cardBody.sentiment.shares.positive).toBe(1);
    expect(cardBody.history.period_days).toBe(1);
    expect(cardBody.history.points).toHaveLength(7);
    // Chart Sentiment sits next to social sentiment, raw and each grade listed separately.
    const chart = (cardBody as unknown as {
      chart_sentiment: {
        status: string;
        raw: { segment: string; label: string; score: number; signals: { key: string; explanation: string }[]; insufficient_history: { key: string }[] };
        graded: { segment: string; grading_company: string; grade: string; label: string }[];
      };
    }).chart_sentiment;
    expect(chart.status).toBe("computed");
    expect(chart.raw).toMatchObject({ segment: "raw", label: "bullish" });
    expect(chart.raw.signals.map((signal) => signal.key)).toContain("uptrend");
    expect(chart.raw.signals[0]!.explanation.length > 0).toBe(true);
    expect(chart.raw.insufficient_history.map((item) => item.key)).toContain("golden_cross");
    expect(chart.graded).toEqual([expect.objectContaining({ segment: "psa10", grading_company: "psa", grade: "10", label: "neutral" })]);
    const other = await app.request(`/v1/printings/${seeded.printings.greninjaJaNormal.id}/sentiment`, { headers: auth });
    expect(((await other.json()) as { chart_sentiment: unknown }).chart_sentiment).toEqual({
      method: "chart-sentiment.v2",
      status: "not_computed",
      raw: null,
      graded: [],
    });

    expect((await app.request(`/v1/printings/${seeded.printings.greninjaEnNormal.id}/sentiment?window=1y`, { headers: auth })).status).toBe(400);

    const products = await app.request("/v1/products?kind=sealed&set=twm", { headers: auth });
    const productBody = (await products.json()) as { data: { key: string; product_type: string }[] };
    expect(productBody.data.map((row) => row.product_type)).toContain("booster_box");

    const box = await app.request("/v1/products/sealed:pokemon:twm:booster_box/sentiment", { headers: auth });
    expect(box.status).toBe(200);
    const boxBody = (await box.json()) as { product: { name: string }; sentiment: { posts: number }; latest_price: unknown };
    expect(boxBody.product.name).toBe("Twilight Masquerade Booster Box");
    expect(boxBody.sentiment.posts).toBe(1);
    expect(boxBody.latest_price).toBeNull();
    expect((await app.request("/v1/products/nope/sentiment", { headers: auth })).status).toBe(404);

    // TCG Card Central card ids resolve through the identifier the catalog import records.
    const tccId = "0b6f1d5e-4c1a-4f7e-9a2b-3c4d5e6f7a8b";
    const otherTccId = "1c7f2e6f-5d2b-4a8f-8b3c-4d5e6f7a8b9c";
    await client.query(
      `INSERT INTO tcg_printing_identifier (id, printing_id, source_namespace, identifier_type, identifier_value, normalized_value)
       VALUES ('tid_api', $1, 'tcg_card_central', 'tcg_card_central_catalog_id', $2, $2)`,
      [seeded.printings.greninjaEnNormal.id, `${tccId}:en`],
    );
    const tccCard = await app.request(`/v1/tcc/cards/${tccId.toUpperCase()}/sentiment?window=7d`, { headers: auth });
    expect(tccCard.status).toBe(200);
    const tccCardBody = (await tccCard.json()) as { tcc_card_id: string; printing: { id: string }; sentiment: { counts: { positive: number } } };
    expect(tccCardBody.tcc_card_id).toBe(tccId);
    expect(tccCardBody.printing.id).toBe(seeded.printings.greninjaEnNormal.id);
    expect(tccCardBody.sentiment.counts.positive).toBe(1);
    expect((tccCardBody as unknown as { chart_sentiment: { raw: { label: string } } }).chart_sentiment.raw.label).toBe("bullish");
    expect((await app.request(`/v1/tcc/cards/${tccId}/sentiment?language=ja`, { headers: auth })).status).toBe(404);
    expect((await app.request("/v1/tcc/cards/not-a-uuid/sentiment", { headers: auth })).status).toBe(400);

    const batch = await app.request(`/v1/tcc/sentiment?ids=${tccId},${otherTccId}&window=7d`, { headers: auth });
    expect(batch.status).toBe(200);
    const batchBody = (await batch.json()) as {
      data: { tcc_card_id: string; label: string; shares: { positive: number }; posts: number }[];
      not_found: string[];
    };
    expect(batchBody.data).toEqual([
      expect.objectContaining({ tcc_card_id: tccId, label: "too_few", posts: 1, shares: expect.objectContaining({ positive: 1 }) }),
    ]);
    expect(batchBody.not_found).toEqual([otherTccId]);
    const batchChart = (batchBody.data[0] as unknown as {
      chart_sentiment: { raw: { label: string; signals: unknown[]; insufficient_history?: unknown }; graded: { segment: string }[] };
    }).chart_sentiment;
    expect(batchChart.raw.label).toBe("bullish");
    expect(batchChart.raw.signals.length <= 3).toBe(true);
    expect(batchChart.raw.insufficient_history).toBeUndefined();
    expect(batchChart.graded.map((row) => row.segment)).toEqual(["psa10"]);
    expect((await app.request("/v1/tcc/sentiment", { headers: auth })).status).toBe(400);
    // The card page and the batch (scans, collections) each count one request for the card that day.
    const demand = await client.query<{ requests: number }>("SELECT requests FROM tcg_printing_demand");
    expect(demand.rows.map((row) => Number(row.requests))).toEqual([2]);

    // Hiding the creator removes their posts from this workspace's sentiment.
    await client.exec(`
      INSERT INTO creator (id, display_name) VALUES ('cr_api', 'Api Channel');
      INSERT INTO creator_source_account (id, creator_id, source_account_id)
        SELECT 'csa_api', 'cr_api', id FROM source_account WHERE external_account_id = 'yt_api_ch';
    `);
    await withOrganizationContext(db, { organizationId: "o_api", userId: "u_api" }, (scoped) =>
      setCreatorPreference(scoped, { organizationId: "o_api", userId: "u_api", creatorId: "cr_api", preference: "hide" }),
    );
    const hidden = await app.request("/v1/products/sealed:pokemon:twm:booster_box/sentiment", { headers: auth });
    const hiddenBody = (await hidden.json()) as { sentiment: { posts: number } };
    expect(hiddenBody.sentiment.posts).toBe(0);

    // Over the monthly plan quota: other reads stop, the TCG Card Central routes keep serving card pages.
    await withOrganizationContext(db, { organizationId: "o_api", userId: "u_api" }, (scoped) =>
      recordUsage(scoped, { id: "usage_over", organizationId: "o_api", meterKey: "api.reads", quantity: 10_000_000 }),
    );
    expect((await app.request("/v1/products/sealed:pokemon:twm:booster_box/sentiment", { headers: auth })).status).toBe(429);
    expect((await app.request(`/v1/tcc/cards/${tccId}/sentiment`, { headers: auth })).status).toBe(200);
    expect((await app.request(`/v1/tcc/sentiment?ids=${tccId}`, { headers: auth })).status).toBe(200);
  });
});
