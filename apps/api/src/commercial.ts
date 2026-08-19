import { asc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import {
  disableWebhookEndpoint,
  getCreatorAuthorityProfile,
  getIndexDefinition,
  getIndexLevelAsOf,
  getLatestScoreSnapshot,
  getLatestTcgMarketSnapshot,
  getMarketFeatureSnapshot,
  insertWebhookEndpoint,
  listCallsByCreator,
  listCreators,
  listIndexDefinitions,
  listIndexLevels,
  listMembershipAsOf,
  listTcgGames,
  listTcgLanguages,
  listTcgListingHistory,
  listTcgSoldHistory,
  listWebhookEndpoints,
  processDueWebhookDeliveries,
  recordUsage,
  tcgCardConcept,
  tcgPrinting,
  tcgSet,
  withMachineContext,
  WebhookUrlRejectedError,
  type Database,
  type DnsLookup,
  type WebhookFetch,
} from "@isp/db";
import {
  EntitlementDeniedError,
  QuotaExceededError,
  assertQuota,
  assertTenantFeature,
  tenantLimit,
} from "@isp/billing";
import { jsonError } from "./errors.js";
import { requireScope, type MachinePrincipal } from "./machine-auth.js";
import { CommercialFilterError, decodeCursor, encodeCursor, parseCommercialQuery } from "./pagination.js";
import { resolveRequestId } from "./request-id.js";
import { requireApiKeyPepper } from "@isp/auth";

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
      if (extraMeter) {
        await recordUsage(scoped, {
          id: crypto.randomUUID(),
          organizationId: machine.organizationId,
          apiKeyId: machine.apiKeyId,
          meterKey: extraMeter,
          quantity: 1,
          idempotencyKey: `${requestId}:${extraMeter}`,
        });
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
      const rows = await c.get("db").select().from(tcgCardConcept).orderBy(asc(tcgCardConcept.id));
      const filtered = rows
        .filter((row) => (filters.game ? row.gameKey === filters.game : true))
        .filter((row) => (after ? row.id > after : true))
        .slice(0, filters.limit + 1);
      const page = filtered.slice(0, filters.limit);
      return c.json({
        data: page.map((row) => ({
          id: row.id,
          game: row.gameKey,
          concept_key: row.conceptKey,
          name: row.canonicalName,
        })),
        next_cursor: filtered.length > filters.limit ? encodeCursor(page.at(-1)!.id) : null,
      });
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
      await meter(c.get("db"), c.get("machine"), requestId);
      const rows = await c.get("db").select().from(tcgSet).orderBy(asc(tcgSet.id));
      const data = rows.filter((row) => (filters.game ? row.gameKey === filters.game : true));
      return c.json({
        data: data.map((row) => ({
          id: row.id,
          game: row.gameKey,
          set: row.canonicalSetKey,
          name: row.name,
          language_scope: row.languageScope,
        })),
        next_cursor: null,
      });
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
        .orderBy(asc(tcgPrinting.id));
      const filtered = rows
        .filter((row) => (filters.game ? row.printing.gameKey === filters.game : true))
        .filter((row) => (filters.set ? row.set.canonicalSetKey === filters.set : true))
        .filter((row) => (filters.language ? row.printing.languageCode === filters.language : true))
        .filter((row) => (filters.variant ? row.printing.variantKey === filters.variant : true))
        .filter((row) => (after ? row.printing.id > after : true))
        .slice(0, filters.limit + 1);
      const page = filtered.slice(0, filters.limit);
      return c.json({
        data: page.map(exactPrinting),
        next_cursor: filtered.length > filters.limit ? encodeCursor(page.at(-1)!.printing.id) : null,
      });
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
      });
      return c.json({
        printing: exactPrinting(row),
        as_of: latest?.observedAt.toISOString() ?? null,
        price: latest?.price == null ? null : Number(latest.price),
        currency: latest?.currency ?? null,
        condition: "nm",
        source: latest?.sourceKey ?? null,
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
        sold: sold.map((item) => ({
          observed_at: item.observedAt.toISOString(),
          price: item.price == null ? null : Number(item.price),
          currency: item.currency,
          source: item.sourceKey,
        })),
        listings: listings.map((item) => ({
          observed_at: item.observedAt.toISOString(),
          listing_count: item.listingCount,
          seller_count: item.sellerCount,
          low_price: item.lowPrice == null ? null : Number(item.lowPrice),
        })),
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
      const rows = await listCreators(c.get("db"));
      return c.json({
        data: rows.map((row) => ({ id: row.id, display_name: row.displayName, status: row.status })),
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
            fetchImpl:
              options?.webhookFetch ??
              (async () => {
                throw new Error("Webhook delivery fetch is not configured.");
              }),
            lookup: options?.dnsLookup,
          }),
      );
      return c.json({ processed: results.length, statuses: results.map((row) => row.status) });
    } catch (error) {
      return commercialError(error, requestId);
    }
  });
}
