import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import {
  disableWebhookEndpoint,
  getCardSentimentWithHistory,
  getCreatorAuthorityProfile,
  getCreatorLeaderboard,
  getMarketAssetByKey,
  getPrintingCalls,
  getTopicCalls,
  getTopicSentiment,
  listMarketAssets,
  getIndexDefinition,
  getIndexLevelAsOf,
  getLatestScoreSnapshot,
  getLatestTcgMarketSnapshot,
  getMarketFeatureSnapshot,
  insertWebhookEndpoint,
  listCallsByCreator,
  listCreators,
  listTenantCreatorList,
  listIndexDefinitions,
  listIndexLevels,
  listMembershipAsOf,
  listTcgGames,
  listTcgLanguages,
  listTcgListingHistory,
  listTcgSoldHistory,
  listSentimentEvidence,
  listWebhookEndpoints,
  processDueWebhookDeliveries,
  recordUsage,
  recordCustomerEvent,
  evaluateUsageWarnings,
  safeWebhookFetch,
  summarizeSentiment,
  EXPLORER_WINDOW_DAYS,
  TCC_ID_TYPE,
  TCC_NAMESPACE,
  tcgCardConcept,
  tcgPrinting,
  tcgPrintingIdentifier,
  tcgSet,
  withMachineContext,
  WebhookUrlRejectedError,
  type Database,
  type DnsLookup,
  type SentimentHistoryPoint,
  type SentimentSummary,
  type TopicCalls,
  type WebhookFetch,
} from "@isp/db";
import {
  EntitlementDeniedError,
  QuotaExceededError,
  assertQuota,
  assertTenantFeature,
  evaluateQuota,
  tenantLimit,
} from "@isp/billing";
import { jsonError } from "./errors.js";
import { requireScope, type MachinePrincipal } from "./machine-auth.js";
import { CommercialFilterError, decodeCursor, encodeCursor, pageEnvelope, parseCommercialQuery } from "./pagination.js";
import { resolveRequestId } from "./request-id.js";
import { requireApiKeyPepper } from "@isp/auth";
import { majorMoneyFields, moneyToFiniteNumber } from "@isp/shared";
import { TCG_LANGUAGE_CODES } from "@isp/contracts";

type App = Hono<{ Variables: { db: Database; machine: MachinePrincipal } }>;

function queryRecord(c: { req: { query: () => Record<string, string> } }) {
  return c.req.query();
}

function exactPrinting(row: {
  printing: typeof tcgPrinting.$inferSelect;
  card: typeof tcgCardConcept.$inferSelect;
  set: typeof tcgSet.$inferSelect;
}) {
  return {
    id: row.printing.id,
    game: row.printing.gameKey,
    card: row.card.canonicalName,
    card_id: row.card.id,
    set: row.set.canonicalSetKey,
    set_name: row.set.name,
    collector_number: row.printing.collectorNumber,
    language: row.printing.languageCode,
    variant: row.printing.variantKey,
    canonical_key: row.printing.canonicalPrintingKey,
  };
}

async function loadPrinting(db: Database, id: string) {
  const [row] = await db
    .select({ printing: tcgPrinting, card: tcgCardConcept, set: tcgSet })
    .from(tcgPrinting)
    .innerJoin(tcgCardConcept, eq(tcgCardConcept.id, tcgPrinting.cardId))
    .innerJoin(tcgSet, eq(tcgSet.id, tcgPrinting.setId))
    .where(eq(tcgPrinting.id, id))
    .limit(1);
  return row ?? null;
}

async function meter(
  db: Database,
  machine: MachinePrincipal,
  requestId: string,
  extraMeter?: "prices.read" | "market_history.read" | "opportunity.read" | "creator.read" | "prediction.read",
) {
  await withMachineContext(
    db,
    { organizationId: machine.organizationId, apiKeyId: machine.apiKeyId },
    async (scoped) => {
      await assertQuota(scoped, { organizationId: machine.organizationId, meterKey: "api.reads" });
      await recordUsage(scoped, {
        id: crypto.randomUUID(),
        organizationId: machine.organizationId,
        apiKeyId: machine.apiKeyId,
        meterKey: "api.reads",
        quantity: 1,
        idempotencyKey: `${requestId}:api.reads`,
      });
      const quota = await evaluateQuota(scoped, {
        organizationId: machine.organizationId,
        meterKey: "api.reads",
      });
      await evaluateUsageWarnings(scoped, {
        organizationId: machine.organizationId,
        meterKey: "api.reads",
        limit: quota.limit,
      });
      if (extraMeter) {
        await recordUsage(scoped, {
          id: crypto.randomUUID(),
          organizationId: machine.organizationId,
          apiKeyId: machine.apiKeyId,
          meterKey: extraMeter,
          quantity: 1,
          idempotencyKey: `${requestId}:${extraMeter}`,
        });
        if (extraMeter === "opportunity.read") {
          await recordCustomerEvent(scoped, {
            organizationId: machine.organizationId,
            eventType: "first_opportunity.viewed",
            idempotencyKey: "first_opportunity.viewed",
          });
        }
      }
    },
  );
}

function commercialError(error: unknown, requestId: string) {
  if (error instanceof CommercialFilterError) {
    return jsonError("validation_error", error.message, 400, requestId);
  }
  if (error instanceof QuotaExceededError) {
    return jsonError("quota_exceeded", "Plan quota exceeded.", 429, requestId);
  }
  if (error instanceof EntitlementDeniedError) {
    return jsonError("entitlement_denied", "Plan entitlement denied.", 402, requestId);
  }
  throw error;
}

const SENTIMENT_WINDOWS = ["7d", "30d", "90d"] as const;
type SentimentWindow = (typeof SENTIMENT_WINDOWS)[number];

function sentimentWindow(raw: string | undefined): SentimentWindow {
  if (raw == null || raw === "") return "30d";
  if ((SENTIMENT_WINDOWS as readonly string[]).includes(raw)) return raw as SentimentWindow;
  throw new CommercialFilterError("window must be one of 7d, 30d, 90d.");
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

/** Creators this workspace hid; their posts and calls are left out of its sentiment. */
async function hiddenCreatorIds(db: Database, machine: MachinePrincipal) {
  const list = await withMachineContext(
    db,
    { organizationId: machine.organizationId, apiKeyId: machine.apiKeyId },
    listTenantCreatorList,
  );
  return list.filter((row) => row.preference === "hide" && row.creatorId).map((row) => row.creatorId!);
}

const TCC_CARD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Most TCG Card Central card ids one batch sentiment request may ask for. */
export const TCC_SENTIMENT_BATCH_MAX = 100;

function tccCardIds(raw: string | undefined): string[] {
  const ids = [...new Set((raw ?? "").split(",").map((id) => id.trim().toLowerCase()).filter(Boolean))];
  if (ids.length === 0) throw new CommercialFilterError("ids must list at least one TCG Card Central card id.");
  if (ids.length > TCC_SENTIMENT_BATCH_MAX) {
    throw new CommercialFilterError(`ids may list at most ${TCC_SENTIMENT_BATCH_MAX} card ids.`);
  }
  if (!ids.every((id) => TCC_CARD_ID.test(id))) throw new CommercialFilterError("ids must be TCG Card Central card ids (uuid).");
  return ids;
}

function tccLanguage(raw: string | undefined): string {
  if (raw == null || raw === "") return "en";
  if ((TCG_LANGUAGE_CODES as readonly string[]).includes(raw)) return raw;
  throw new CommercialFilterError("language is not recognized.");
}

/**
 * Our printing for each imported TCG Card Central card in one language. The
 * catalog import records "<TCC card id>:<language>" on every printing it creates.
 */
async function printingIdsForTccCards(db: Database, ids: string[], language: string) {
  const wanted = new Map(ids.map((id) => [`${id}:${language}`.normalize("NFKC").toLowerCase(), id]));
  const rows = await db
    .select({ printingId: tcgPrintingIdentifier.printingId, value: tcgPrintingIdentifier.normalizedValue })
    .from(tcgPrintingIdentifier)
    .where(
      and(
        eq(tcgPrintingIdentifier.sourceNamespace, TCC_NAMESPACE),
        eq(tcgPrintingIdentifier.identifierType, TCC_ID_TYPE),
        inArray(tcgPrintingIdentifier.normalizedValue, [...wanted.keys()]),
      ),
    );
  const found = new Map<string, string>();
  for (const row of rows) {
    const id = wanted.get(row.value);
    if (id) found.set(id, row.printingId);
  }
  return found;
}

function sentimentShares(summary: SentimentSummary) {
  const share = (key: "positive" | "neutral" | "negative" | "mixed") =>
    summary.weightTotal > 0 ? round4(summary.weighted[key] / summary.weightTotal) : 0;
  return { positive: share("positive"), neutral: share("neutral"), negative: share("negative"), mixed: share("mixed") };
}

function sentimentBody(input: {
  window: SentimentWindow;
  summary: SentimentSummary;
  history: SentimentHistoryPoint[];
  bucketDays: number;
  calls: TopicCalls;
}) {
  const { summary, calls } = input;
  return {
    window: input.window,
    as_of: summary.to.toISOString(),
    sentiment: {
      label: summary.label,
      basis: summary.basis,
      shares: sentimentShares(summary),
      counts: summary.counts,
      posts: summary.contentItems,
      classified_posts: summary.classified,
      posts_from_rated_creators: summary.ratedPosts,
      accounts: summary.uniqueAccounts,
    },
    history: {
      period_days: input.bucketDays,
      points: input.history.map((point) => ({
        start: point.start.toISOString(),
        end: point.end.toISOString(),
        label: point.label,
        posts: point.posts,
        shares: {
          positive: round4(point.shares.positive),
          neutral: round4(point.shares.neutral),
          negative: round4(point.shares.negative),
          mixed: round4(point.shares.mixed),
        },
      })),
    },
    calls: {
      total: calls.total,
      evaluated: calls.evaluated,
      came_true: calls.correct,
      waiting_for_market: calls.pending,
      accuracy: calls.evaluated > 0 ? round4(calls.correct / calls.evaluated) : null,
    },
  };
}

function productBody(row: { asset: { assetKey: string; kind: string; displayName: string; productType: string | null; gameKey: string | null; languageCode: string | null; quoteCurrency: string }; setKey: string | null; setName: string | null }) {
  return {
    key: row.asset.assetKey,
    kind: row.asset.kind,
    name: row.asset.displayName,
    product_type: row.asset.productType,
    game: row.asset.gameKey,
    set: row.setKey ? { key: row.setKey, name: row.setName } : null,
    language: row.asset.languageCode,
    quote_currency: row.asset.quoteCurrency,
  };
}

export function registerCommercialRoutes(
  app: App,
  options?: { env?: NodeJS.ProcessEnv; webhookFetch?: WebhookFetch; dnsLookup?: DnsLookup },
) {
  app.get("/v1/cards", requireScope("cards:read"), async (c) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    try {
      const filters = parseCommercialQuery(queryRecord(c));
      const after = decodeCursor(filters.cursor);
      await meter(c.get("db"), c.get("machine"), requestId);
      const rows = await c
        .get("db")
        .select()
        .from(tcgCardConcept)
        .where(
          and(
            after ? gt(tcgCardConcept.id, after) : undefined,
            filters.game ? eq(tcgCardConcept.gameKey, filters.game) : undefined,
          ),
        )
        .orderBy(asc(tcgCardConcept.id))
        .limit(filters.limit + 1);
      const filtered = rows;
      const page = filtered.slice(0, filters.limit);
      return c.json(
        pageEnvelope({
          data: page.map((row) => ({
            id: row.id,
            game: row.gameKey,
            concept_key: row.conceptKey,
            name: row.canonicalName,
          })),
          nextCursor: filtered.length > filters.limit ? encodeCursor(page.at(-1)!.id) : null,
          limit: filters.limit,
          requestId,
        }),
      );
    } catch (error) {
      return commercialError(error, requestId);
    }
  });

  app.get("/v1/cards/:id", requireScope("cards:read"), async (c) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    try {
      await meter(c.get("db"), c.get("machine"), requestId);
      const [row] = await c
        .get("db")
        .select()
        .from(tcgCardConcept)
        .where(eq(tcgCardConcept.id, c.req.param("id")))
        .limit(1);
      if (!row) {
        return jsonError("not_found", "Card not found.", 404, requestId);
      }
      return c.json({ id: row.id, game: row.gameKey, concept_key: row.conceptKey, name: row.canonicalName });
    } catch (error) {
      return commercialError(error, requestId);
    }
  });

  app.get("/v1/sets", requireScope("cards:read"), async (c) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    try {
      const filters = parseCommercialQuery(queryRecord(c));
      const after = decodeCursor(filters.cursor);
      await meter(c.get("db"), c.get("machine"), requestId);
      const rows = await c
        .get("db")
        .select()
        .from(tcgSet)
        .where(
          and(
            after ? gt(tcgSet.id, after) : undefined,
            filters.game ? eq(tcgSet.gameKey, filters.game) : undefined,
          ),
        )
        .orderBy(asc(tcgSet.id))
        .limit(filters.limit + 1);
      const page = rows.slice(0, filters.limit);
      return c.json(
        pageEnvelope({
          data: page.map((row) => ({
            id: row.id,
            game: row.gameKey,
            set: row.canonicalSetKey,
            name: row.name,
            language_scope: row.languageScope,
          })),
          nextCursor: rows.length > filters.limit ? encodeCursor(page.at(-1)!.id) : null,
          limit: filters.limit,
          requestId,
        }),
      );
    } catch (error) {
      return commercialError(error, requestId);
    }
  });

  app.get("/v1/printings", requireScope("cards:read"), async (c) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    try {
      const filters = parseCommercialQuery(queryRecord(c));
      const after = decodeCursor(filters.cursor);
      await meter(c.get("db"), c.get("machine"), requestId);
      const rows = await c
        .get("db")
        .select({ printing: tcgPrinting, card: tcgCardConcept, set: tcgSet })
        .from(tcgPrinting)
        .innerJoin(tcgCardConcept, eq(tcgCardConcept.id, tcgPrinting.cardId))
        .innerJoin(tcgSet, eq(tcgSet.id, tcgPrinting.setId))
        .where(
          and(
            after ? gt(tcgPrinting.id, after) : undefined,
            filters.game ? eq(tcgPrinting.gameKey, filters.game) : undefined,
            filters.set ? eq(tcgSet.canonicalSetKey, filters.set) : undefined,
            filters.language ? eq(tcgPrinting.languageCode, filters.language) : undefined,
            filters.variant ? eq(tcgPrinting.variantKey, filters.variant) : undefined,
          ),
        )
        .orderBy(asc(tcgPrinting.id))
        .limit(filters.limit + 1);
      const filtered = rows;
      const page = filtered.slice(0, filters.limit);
      return c.json(
        pageEnvelope({
          data: page.map(exactPrinting),
          nextCursor: filtered.length > filters.limit ? encodeCursor(page.at(-1)!.printing.id) : null,
          limit: filters.limit,
          requestId,
        }),
      );
    } catch (error) {
      return commercialError(error, requestId);
    }
  });

  app.get("/v1/printings/:id", requireScope("cards:read"), async (c) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    try {
      await meter(c.get("db"), c.get("machine"), requestId);
      const row = await loadPrinting(c.get("db"), c.req.param("id"));
      if (!row) {
        return jsonError("not_found", "Printing not found.", 404, requestId);
      }
      return c.json(exactPrinting(row));
    } catch (error) {
      return commercialError(error, requestId);
    }
  });

  app.get("/v1/printings/:id/prices", requireScope("prices:read"), async (c) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    try {
      await meter(c.get("db"), c.get("machine"), requestId, "prices.read");
      const row = await loadPrinting(c.get("db"), c.req.param("id"));
      if (!row) {
        return jsonError("not_found", "Printing not found.", 404, requestId);
      }
      const latest = await getLatestTcgMarketSnapshot(c.get("db"), {
        printingId: row.printing.id,
        priceType: "sold",
        condition: "nm",
        gradingCompany: null,
        outlierFlag: false,
        hasPrice: true,
      });
      const money = majorMoneyFields(latest?.price ?? null, latest?.currency ?? null);
      return c.json({
        printing: exactPrinting(row),
        as_of: latest?.observedAt.toISOString() ?? null,
        price: money.amount == null ? null : moneyToFiniteNumber(money.amount),
        amount: money.amount,
        currency: money.currency,
        unit: money.unit,
        condition: "nm",
        source: latest?.sourceKey ?? null,
        outlier: false,
      });
    } catch (error) {
      return commercialError(error, requestId);
    }
  });

  app.get("/v1/printings/:id/market-history", requireScope("markets:read"), async (c) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    const machine = c.get("machine");
    try {
      const filters = parseCommercialQuery(queryRecord(c));
      await meter(c.get("db"), machine, requestId, "market_history.read");
      const row = await loadPrinting(c.get("db"), c.req.param("id"));
      if (!row) {
        return jsonError("not_found", "Printing not found.", 404, requestId);
      }
      const depth = await withMachineContext(
        c.get("db"),
        { organizationId: machine.organizationId, apiKeyId: machine.apiKeyId },
        (scoped) => tenantLimit(scoped, machine.organizationId, "history_depth_days"),
      );
      const floor = new Date(Date.now() - depth * 86_400_000);
      const from = filters.from && filters.from.getTime() > floor.getTime() ? filters.from : floor;
      const sold = await listTcgSoldHistory(c.get("db"), {
        printingId: row.printing.id,
        condition: filters.condition ?? "nm",
        sourceKey: filters.source,
        from,
        to: filters.to,
        gradingCompany: null,
      });
      const listings = await listTcgListingHistory(c.get("db"), {
        printingId: row.printing.id,
        condition: filters.condition ?? "nm",
        from,
        to: filters.to,
      });
      return c.json({
        printing: exactPrinting(row),
        sold: sold.map((item) => {
          const money = majorMoneyFields(item.price ?? null, item.currency);
          return {
            observed_at: item.observedAt.toISOString(),
            price: money.amount == null ? null : moneyToFiniteNumber(money.amount),
            amount: money.amount,
            currency: money.currency,
            unit: money.unit,
            source: item.sourceKey,
            outlier: item.outlierFlag,
          };
        }),
        listings: listings.map((item) => {
          const money = majorMoneyFields(item.lowPrice ?? item.price ?? null, item.currency);
          return {
            observed_at: item.observedAt.toISOString(),
            listing_count: item.listingCount,
            seller_count: item.sellerCount,
            low_price: money.amount == null ? null : moneyToFiniteNumber(money.amount),
            amount: money.amount,
            currency: money.currency,
            unit: money.unit,
          };
        }),
      });
    } catch (error) {
      return commercialError(error, requestId);
    }
  });

  app.get("/v1/printings/:id/signals", requireScope("signals:read"), async (c) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    try {
      await meter(c.get("db"), c.get("machine"), requestId);
      const row = await loadPrinting(c.get("db"), c.req.param("id"));
      if (!row) {
        return jsonError("not_found", "Printing not found.", 404, requestId);
      }
      const snapshot = await getMarketFeatureSnapshot(c.get("db"), { printingId: row.printing.id });
      const features = (snapshot?.features ?? {}) as Record<string, unknown>;
      const candidates = (features.candidates ?? {}) as Record<string, unknown>;
      const manipulation = (features.manipulation_foundation ?? {}) as Record<string, unknown>;
      return c.json({
        printing: exactPrinting(row),
        as_of: snapshot?.asOf.toISOString() ?? null,
        breakout: candidates.breakout === true,
        reversal: candidates.reversal === true,
        anomaly: candidates.anomaly === true,
        manipulation,
      });
    } catch (error) {
      return commercialError(error, requestId);
    }
  });

  app.get("/v1/printings/:id/sentiment", requireScope("signals:read"), async (c) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    try {
      const window = sentimentWindow(c.req.query("window"));
      await meter(c.get("db"), c.get("machine"), requestId);
      const row = await loadPrinting(c.get("db"), c.req.param("id"));
      if (!row) {
        return jsonError("not_found", "Printing not found.", 404, requestId);
      }
      const hidden = await hiddenCreatorIds(c.get("db"), c.get("machine"));
      const [sentiment, calls] = await Promise.all([
        getCardSentimentWithHistory(c.get("db"), row.printing.id, window, { hiddenCreatorIds: hidden }),
        getPrintingCalls(c.get("db"), row.printing.id, { hiddenCreatorIds: hidden }),
      ]);
      return c.json({ printing: exactPrinting(row), ...sentimentBody({ window, ...sentiment, calls }) });
    } catch (error) {
      return commercialError(error, requestId);
    }
  });

  app.get("/v1/tcc/cards/:tccCardId/sentiment", requireScope("signals:read"), async (c) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    try {
      const window = sentimentWindow(c.req.query("window"));
      const language = tccLanguage(c.req.query("language"));
      const [tccCardId] = tccCardIds(c.req.param("tccCardId"));
      await meter(c.get("db"), c.get("machine"), requestId);
      const printingId = (await printingIdsForTccCards(c.get("db"), [tccCardId!], language)).get(tccCardId!);
      const row = printingId ? await loadPrinting(c.get("db"), printingId) : null;
      if (!row) {
        return jsonError("not_found", "No printing for this TCG Card Central card in this language.", 404, requestId);
      }
      const hidden = await hiddenCreatorIds(c.get("db"), c.get("machine"));
      const [sentiment, calls] = await Promise.all([
        getCardSentimentWithHistory(c.get("db"), row.printing.id, window, { hiddenCreatorIds: hidden }),
        getPrintingCalls(c.get("db"), row.printing.id, { hiddenCreatorIds: hidden }),
      ]);
      return c.json({
        tcc_card_id: tccCardId,
        printing: exactPrinting(row),
        ...sentimentBody({ window, ...sentiment, calls }),
      });
    } catch (error) {
      return commercialError(error, requestId);
    }
  });

  // Current sentiment for a page of TCG Card Central cards in one request, without history or calls.
  app.get("/v1/tcc/sentiment", requireScope("signals:read"), async (c) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    try {
      const window = sentimentWindow(c.req.query("window"));
      const language = tccLanguage(c.req.query("language"));
      const ids = tccCardIds(c.req.query("ids"));
      await meter(c.get("db"), c.get("machine"), requestId);
      const printings = await printingIdsForTccCards(c.get("db"), ids, language);
      const hidden = await hiddenCreatorIds(c.get("db"), c.get("machine"));
      const to = new Date();
      const range = { from: new Date(to.getTime() - EXPLORER_WINDOW_DAYS[window] * 86_400_000), to };
      const evidence = await listSentimentEvidence(c.get("db"), [...new Set(printings.values())], range, {
        hiddenCreatorIds: hidden,
      });
      const byPrinting = new Map<string, typeof evidence>();
      for (const row of evidence) byPrinting.set(row.printingId, [...(byPrinting.get(row.printingId) ?? []), row]);
      return c.json({
        window,
        language,
        as_of: to.toISOString(),
        data: ids
          .filter((id) => printings.has(id))
          .map((id) => {
            const printingId = printings.get(id)!;
            const summary = summarizeSentiment(byPrinting.get(printingId) ?? [], range);
            return {
              tcc_card_id: id,
              printing_id: printingId,
              label: summary.label,
              basis: summary.basis,
              shares: sentimentShares(summary),
              posts: summary.contentItems,
              classified_posts: summary.classified,
              accounts: summary.uniqueAccounts,
            };
          }),
        not_found: ids.filter((id) => !printings.has(id)),
      });
    } catch (error) {
      return commercialError(error, requestId);
    }
  });

  app.get("/v1/products", requireScope("cards:read"), async (c) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    try {
      const kind = c.req.query("kind") || undefined;
      if (kind && !["sealed", "other"].includes(kind)) {
        throw new CommercialFilterError("kind is not recognized.");
      }
      await meter(c.get("db"), c.get("machine"), requestId);
      const rows = await listMarketAssets(c.get("db"), {
        kind,
        gameKey: c.req.query("game") || undefined,
        setKey: c.req.query("set") || undefined,
      });
      return c.json({ data: rows.map(productBody) });
    } catch (error) {
      return commercialError(error, requestId);
    }
  });

  app.get("/v1/products/:key/sentiment", requireScope("signals:read"), async (c) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    try {
      const window = sentimentWindow(c.req.query("window"));
      await meter(c.get("db"), c.get("machine"), requestId);
      const row = await getMarketAssetByKey(c.get("db"), c.req.param("key"));
      if (!row || row.asset.status !== "active") {
        return jsonError("not_found", "Product not found.", 404, requestId);
      }
      const hidden = await hiddenCreatorIds(c.get("db"), c.get("machine"));
      const [topic, calls] = await Promise.all([
        getTopicSentiment(c.get("db"), row.asset.displayName, window, { hiddenCreatorIds: hidden }),
        getTopicCalls(c.get("db"), row.asset.id, { hiddenCreatorIds: hidden }),
      ]);
      return c.json({
        product: productBody(row),
        ...sentimentBody({ window, summary: topic.summary, history: topic.history, bucketDays: topic.bucketDays, calls }),
        latest_price: calls.latestPrice
          ? {
              price: moneyToFiniteNumber(calls.latestPrice.price),
              currency: calls.latestPrice.currency,
              observed_at: calls.latestPrice.observedAt.toISOString(),
              source: calls.latestPrice.sourceKey,
            }
          : null,
      });
    } catch (error) {
      return commercialError(error, requestId);
    }
  });

  app.get("/v1/printings/:id/opportunity", requireScope("opportunities:read"), async (c) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    try {
      await meter(c.get("db"), c.get("machine"), requestId, "opportunity.read");
      const row = await loadPrinting(c.get("db"), c.req.param("id"));
      if (!row) {
        return jsonError("not_found", "Printing not found.", 404, requestId);
      }
      const score = await getLatestScoreSnapshot(c.get("db"), row.printing.id);
      if (!score) {
        return jsonError("not_found", "Opportunity score not found.", 404, requestId);
      }
      return c.json({
        printing: exactPrinting(row),
        as_of: score.asOf.toISOString(),
        opportunity: Number(score.opportunityScore),
        risk: Number(score.riskScore),
        confidence: Number(score.confidenceScore),
        liquidity: Number(score.liquidityScore),
        recommendation: score.recommendation,
        explanation: score.explanations,
        version: score.scoreVersion,
      });
    } catch (error) {
      return commercialError(error, requestId);
    }
  });

  app.get("/v1/printings/:id/predictions", requireScope("predictions:read"), async (c) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    const machine = c.get("machine");
    try {
      await withMachineContext(
        c.get("db"),
        { organizationId: machine.organizationId, apiKeyId: machine.apiKeyId },
        (scoped) => assertTenantFeature(scoped, machine.organizationId, "predictions"),
      );
      await meter(c.get("db"), machine, requestId, "prediction.read");
      return jsonError("prediction_not_published", "Predictions remain in shadow mode.", 404, requestId);
    } catch (error) {
      return commercialError(error, requestId);
    }
  });

  app.get("/v1/markets", requireScope("markets:read"), async (c) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    try {
      await meter(c.get("db"), c.get("machine"), requestId);
      const [games, languages] = await Promise.all([
        listTcgGames(c.get("db")),
        listTcgLanguages(c.get("db")),
      ]);
      return c.json({
        games: games.map((row) => ({ game: row.gameKey, name: row.displayName })),
        languages: languages.map((row) => ({ language: row.languageCode, name: row.displayName })),
        note: "English, Japanese, and Simplified Chinese markets are never merged automatically.",
      });
    } catch (error) {
      return commercialError(error, requestId);
    }
  });

  app.get("/v1/indices", requireScope("markets:read"), async (c) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    try {
      const filters = parseCommercialQuery(queryRecord(c));
      await meter(c.get("db"), c.get("machine"), requestId);
      const rows = await listIndexDefinitions(c.get("db"), {
        gameKey: filters.game,
        languageCode: filters.language,
      });
      return c.json({
        data: rows.map((row) => ({
          index_key: row.indexKey,
          name: row.name,
          game: row.gameKey,
          language: row.languageCode,
          weighting_method: row.weightingMethod,
          status: row.status,
        })),
      });
    } catch (error) {
      return commercialError(error, requestId);
    }
  });

  app.get("/v1/indices/:index_key", requireScope("markets:read"), async (c) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    try {
      const filters = parseCommercialQuery(queryRecord(c));
      await meter(c.get("db"), c.get("machine"), requestId);
      const definition = await getIndexDefinition(c.get("db"), c.req.param("index_key"));
      if (!definition) {
        return jsonError("not_found", "Index not found.", 404, requestId);
      }
      const latest = await getIndexLevelAsOf(c.get("db"), definition.indexKey, new Date());
      const membership = filters.includeMembership
        ? await listMembershipAsOf(c.get("db"), definition.indexKey, latest?.observedAt ?? new Date())
        : undefined;
      return c.json({
        index_key: definition.indexKey,
        name: definition.name,
        game: definition.gameKey,
        language: definition.languageCode,
        latest: latest
          ? {
              as_of: latest.observedAt.toISOString(),
              value: Number(latest.indexValue),
              component_count: latest.componentCount,
              coverage: latest.coverage == null ? null : Number(latest.coverage),
              data_quality: latest.dataQuality,
              method_version: latest.methodVersion,
            }
          : null,
        membership: membership?.map((row) => ({
          printing_id: row.printingId,
          effective_from: row.effectiveFrom.toISOString(),
          effective_to: row.effectiveTo?.toISOString() ?? null,
        })),
      });
    } catch (error) {
      return commercialError(error, requestId);
    }
  });

  app.get("/v1/indices/:index_key/history", requireScope("markets:read"), async (c) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    try {
      await meter(c.get("db"), c.get("machine"), requestId);
      const levels = await listIndexLevels(c.get("db"), c.req.param("index_key"));
      return c.json({
        data: levels.map((row) => ({
          as_of: row.observedAt.toISOString(),
          value: Number(row.indexValue),
          component_count: row.componentCount,
          data_quality: row.dataQuality,
        })),
      });
    } catch (error) {
      return commercialError(error, requestId);
    }
  });

  app.get("/v1/creators", requireScope("creators:read"), async (c) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    const machine = c.get("machine");
    try {
      await withMachineContext(
        c.get("db"),
        { organizationId: machine.organizationId, apiKeyId: machine.apiKeyId },
        (scoped) => assertTenantFeature(scoped, machine.organizationId, "creator_analytics"),
      );
      await meter(c.get("db"), machine, requestId, "creator.read");
      // The workspace's private list: hidden creators are left out, follows are flagged.
      const list = await withMachineContext(
        c.get("db"),
        { organizationId: machine.organizationId, apiKeyId: machine.apiKeyId },
        listTenantCreatorList,
      );
      const preference = new Map(list.filter((row) => row.creatorId).map((row) => [row.creatorId!, row.preference]));
      const followingOnly = c.req.query("list") === "following";
      const rows = (await listCreators(c.get("db"))).filter((row) =>
        followingOnly ? preference.get(row.id) === "follow" : preference.get(row.id) !== "hide",
      );
      return c.json({
        data: rows.map((row) => ({
          id: row.id,
          display_name: row.displayName,
          status: row.status,
          following: preference.get(row.id) === "follow",
        })),
      });
    } catch (error) {
      return commercialError(error, requestId);
    }
  });

  // Registered before /v1/creators/:id so "leaderboard" is never read as an id.
  app.get("/v1/creators/leaderboard", requireScope("creators:read"), async (c) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    const machine = c.get("machine");
    const game = c.req.query("game")?.trim().toLowerCase() || null;
    if (game && !/^[a-z][a-z0-9_]{0,39}$/.test(game)) {
      return jsonError("validation_error", "game must be a game key such as pokemon.", 400, requestId);
    }
    try {
      await withMachineContext(
        c.get("db"),
        { organizationId: machine.organizationId, apiKeyId: machine.apiKeyId },
        (scoped) => assertTenantFeature(scoped, machine.organizationId, "creator_analytics"),
      );
      await meter(c.get("db"), machine, requestId, "creator.read");
      // Creators this workspace hid stay off its leaderboard, as they stay out of its sentiment.
      const hidden = await hiddenCreatorIds(c.get("db"), machine);
      const board = await getCreatorLeaderboard(c.get("db"), { game, hiddenCreatorIds: hidden });
      const row = (entry: (typeof board.ranked)[number]) => ({
        rank: entry.rank,
        creator_id: entry.creatorId,
        display_name: entry.name,
        platforms: entry.platforms,
        calls_made: entry.callsMade,
        calls_evaluated: entry.callsEvaluated,
        came_true: entry.cameTrue,
        accuracy: entry.accuracy,
        accuracy_lower_bound: entry.wilsonLow,
        authority_weight: entry.authorityWeight,
        trust_state: entry.trustState,
        last_call_at: entry.lastCallAt,
      });
      return c.json({
        game: board.game,
        window_days: board.windowDays,
        min_evaluated_calls: board.minEvaluated,
        from: board.from,
        to: board.to,
        data: board.ranked.map(row),
        not_enough_calls: board.notEnoughCalls.map(row),
      });
    } catch (error) {
      return commercialError(error, requestId);
    }
  });

  app.get("/v1/creators/:id", requireScope("creators:read"), async (c) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    const machine = c.get("machine");
    try {
      await withMachineContext(
        c.get("db"),
        { organizationId: machine.organizationId, apiKeyId: machine.apiKeyId },
        (scoped) => assertTenantFeature(scoped, machine.organizationId, "creator_analytics"),
      );
      await meter(c.get("db"), machine, requestId, "creator.read");
      const profile = await getCreatorAuthorityProfile(c.get("db"), c.req.param("id"));
      if (!profile.creator) {
        return jsonError("not_found", "Creator not found.", 404, requestId);
      }
      return c.json({
        id: profile.creator.id,
        display_name: profile.creator.displayName,
        trust_state: profile.trustState,
        total_calls: profile.totalCalls,
        discovery: profile.discovery.map((row) => ({
          provider: row.providerKey,
          relevance_state: row.relevanceState,
          relevance_score: row.relevanceScore,
          topic_hits: row.topicHits,
          reach_views: row.reachViews,
          reach_subscribers: row.reachSubscribers,
        })),
        slices: profile.slices.map((slice) => ({
          game: slice.gameKey,
          language: slice.languageCode,
          horizon: slice.horizonCode,
          sample_size: Number(slice.sampleSize),
          trust_state: slice.trustState,
        })),
      });
    } catch (error) {
      return commercialError(error, requestId);
    }
  });

  app.get("/v1/creators/:id/calls", requireScope("creators:read"), async (c) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    const machine = c.get("machine");
    try {
      await withMachineContext(
        c.get("db"),
        { organizationId: machine.organizationId, apiKeyId: machine.apiKeyId },
        (scoped) => assertTenantFeature(scoped, machine.organizationId, "creator_analytics"),
      );
      await meter(c.get("db"), machine, requestId, "creator.read");
      const calls = await listCallsByCreator(c.get("db"), c.req.param("id"));
      return c.json({
        data: calls.map((row) => ({
          id: row.id,
          direction: row.direction,
          horizon: row.horizonCode,
          published_at: row.publishedAt.toISOString(),
          printing_id: row.printingId,
          resolution_status: row.resolutionStatus,
        })),
      });
    } catch (error) {
      return commercialError(error, requestId);
    }
  });

  app.get("/v1/webhooks", requireScope("webhooks:manage"), async (c) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    const machine = c.get("machine");
    try {
      await withMachineContext(
        c.get("db"),
        { organizationId: machine.organizationId, apiKeyId: machine.apiKeyId },
        (scoped) => assertTenantFeature(scoped, machine.organizationId, "webhooks"),
      );
      const rows = await withMachineContext(
        c.get("db"),
        { organizationId: machine.organizationId, apiKeyId: machine.apiKeyId },
        (scoped) => listWebhookEndpoints(scoped, machine.organizationId),
      );
      return c.json({
        data: rows.map((row) => ({
          id: row.id,
          url: row.url,
          status: row.status,
          event_types: row.eventTypes,
        })),
      });
    } catch (error) {
      return commercialError(error, requestId);
    }
  });

  app.post("/v1/webhooks", requireScope("webhooks:manage"), async (c) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    const machine = c.get("machine");
    try {
      const pepper = requireApiKeyPepper(options?.env);
      const body = (await c.req.json()) as { url?: string; event_types?: string[] };
      await withMachineContext(
        c.get("db"),
        { organizationId: machine.organizationId, apiKeyId: machine.apiKeyId },
        (scoped) => assertTenantFeature(scoped, machine.organizationId, "webhooks"),
      );
      const created = await withMachineContext(
        c.get("db"),
        { organizationId: machine.organizationId, apiKeyId: machine.apiKeyId },
        (scoped) =>
          insertWebhookEndpoint(scoped, {
            organizationId: machine.organizationId,
            url: String(body.url ?? ""),
            eventTypes: body.event_types ?? [],
            pepper,
          }),
      );
      return c.json(
        {
          id: created.endpoint.id,
          url: created.endpoint.url,
          event_types: created.endpoint.eventTypes,
          secret: created.secret,
          signing_version: "hmac-sha256.v1",
        },
        201,
      );
    } catch (error) {
      if (error instanceof WebhookUrlRejectedError) {
        return jsonError("validation_error", error.message, 400, requestId);
      }
      if (error instanceof Error && error.message === "Unsupported webhook event type.") {
        return jsonError("validation_error", error.message, 400, requestId);
      }
      return commercialError(error, requestId);
    }
  });

  app.delete("/v1/webhooks/:id", requireScope("webhooks:manage"), async (c) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    const machine = c.get("machine");
    try {
      await withMachineContext(
        c.get("db"),
        { organizationId: machine.organizationId, apiKeyId: machine.apiKeyId },
        (scoped) => assertTenantFeature(scoped, machine.organizationId, "webhooks"),
      );
      const row = await withMachineContext(
        c.get("db"),
        { organizationId: machine.organizationId, apiKeyId: machine.apiKeyId },
        (scoped) => disableWebhookEndpoint(scoped, { organizationId: machine.organizationId, endpointId: c.req.param("id") }),
      );
      if (!row) {
        return jsonError("not_found", "Webhook endpoint not found.", 404, requestId);
      }
      return c.json({ id: row.id, status: row.status });
    } catch (error) {
      return commercialError(error, requestId);
    }
  });

  app.post("/v1/webhooks/deliveries/process", requireScope("webhooks:manage"), async (c) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    const machine = c.get("machine");
    try {
      const pepper = requireApiKeyPepper(options?.env);
      const results = await withMachineContext(
        c.get("db"),
        { organizationId: machine.organizationId, apiKeyId: machine.apiKeyId },
        (scoped) =>
          processDueWebhookDeliveries(scoped, {
            organizationId: machine.organizationId,
            pepper,
            fetchImpl: options?.webhookFetch ?? safeWebhookFetch,
            lookup: options?.dnsLookup,
          }),
      );
      return c.json({ processed: results.length, statuses: results.map((row) => row.status) });
    } catch (error) {
      return commercialError(error, requestId);
    }
  });
}
