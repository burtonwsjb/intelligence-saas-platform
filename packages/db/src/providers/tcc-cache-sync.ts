import { randomUUID } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { withPlatformContext } from "../rls.js";
import { providerRuntime } from "../schema/provider.js";
import { tcgCardConcept, tcgPrinting, tcgSet } from "../schema/tcg.js";
import { receiveTcgMarketRecord } from "../tcg/market-ingest.js";
import { providerCredentialStatus, resolveProviderMode } from "./catalog.js";
import { tcgMarketIngest } from "../schema/tcg-market.js";
import { ensureProviderRuntimeRows, finishProviderSyncRun, getProviderRuntime, insertProviderSyncRun,
  recordProviderSyncResult, releaseProviderLease, tryAcquireProviderLease } from "./runtime.js";
import { fetchTccCachedMarket, TCC_BATCH_LIMIT, type TccMarketTarget } from "./tcc-cache-client.js";
import { ProviderHttpError, type HttpTransport } from "./transport.js";

const PROVIDER = "tcg_card_central";

/** Bounded keyset walk of our public canonical catalog. No manual vendor IDs and no tenant rows. */
export async function selectTccMarketTargets(db: Database, limit: number, after: string | null = null): Promise<TccMarketTarget[]> {
  const count = Math.min(TCC_BATCH_LIMIT, Math.max(1, Math.floor(limit)));
  const rows = await db.select({
    id: tcgPrinting.id, game: tcgPrinting.gameKey, language: tcgPrinting.languageCode,
    collector: tcgPrinting.collectorNumber, variant: tcgPrinting.variantKey,
    cardName: tcgCardConcept.canonicalName, setName: tcgSet.name, setKey: tcgSet.canonicalSetKey,
  }).from(tcgPrinting)
    .innerJoin(tcgCardConcept, eq(tcgCardConcept.id, tcgPrinting.cardId))
    .innerJoin(tcgSet, eq(tcgSet.id, tcgPrinting.setId))
    .where(and(eq(tcgPrinting.status, "active"), eq(tcgCardConcept.status, "active"), eq(tcgSet.status, "active"),
      after ? gt(tcgPrinting.id, after) : undefined,
      // Stored market observations are not a second upstream cache. Once today's
      // exact NM/raw/USD reference exists there is no reason to re-request it.
      sql`NOT EXISTS (SELECT 1 FROM public.tcg_market_snapshot m WHERE m.printing_id = ${tcgPrinting.id}
        AND m.source_key = 'tcg_card_central' AND m.currency = 'USD' AND m.price_type = 'reference'
        AND m.condition = 'nm' AND m.grading_company IS NULL AND m.grade_label IS NULL
        AND m.price > 0 AND m.outlier_flag = false
        AND m.observed_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        AND m.observed_at <= now())`))
    .orderBy(tcgPrinting.id).limit(count);
  return rows.map((row) => ({ canonicalSetKey: row.setKey, request: {
    request_id: row.id, game_key: row.game, language_code: row.language,
    card_name: row.cardName, set_name: row.setName, collector_number: row.collector,
    variant_key: row.variant, condition: "nm", grading_company: null, grade_label: null, tcc_card_id: null,
  } }));
}

export type TccSyncInput = {
  trigger: "schedule" | "admin" | "staging_ingest" | "smoke";
  limit?: number; env?: NodeJS.ProcessEnv; transport?: HttpTransport;
};

/** TCC owns cache misses and vendors. Never hold a Postgres transaction across that HTTP request. */
export async function syncTccCachedMarket(db: Database, input: TccSyncInput) {
  const env = input.env ?? process.env;
  const skipped = (reason: string) => ({ status: "skipped" as const, reason, received: 0, quarantined: 0 });
  if (resolveProviderMode(PROVIDER, env) !== "live") return skipped("not_live");
  if (!providerCredentialStatus(PROVIDER, env).present) return skipped("disabled_pending_credentials");
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50)) return skipped("invalid_limit");
  const limit = Math.min(input.limit ?? TCC_BATCH_LIMIT, TCC_BATCH_LIMIT);
  const runId = `psr_tcc_${randomUUID()}`;
  const preparation = await withPlatformContext(db, async (tx) => {
    await ensureProviderRuntimeRows(tx, env);
    const runtime = await getProviderRuntime(tx, PROVIDER);
    if (!runtime?.enabled || runtime.paused || runtime.mode !== "live") return { reason: "paused_or_disabled" as const };
    if (runtime.retryAfterAt && runtime.retryAfterAt.getTime() > Date.now()) return { reason: "throttled" as const };
    if (!await tryAcquireProviderLease(tx, PROVIDER)) return { reason: "overlap" as const };
    const after = typeof runtime.cursor?.tcc_catalog_after === "string" ? runtime.cursor.tcc_catalog_after : null;
    let targets = await selectTccMarketTargets(tx, limit, after);
    if (!targets.length && after) targets = await selectTccMarketTargets(tx, limit);
    await insertProviderSyncRun(tx, { id: runId, providerKey: PROVIDER, mode: "live", trigger: input.trigger, limitCount: limit });
    return { targets };
  });
  if ("reason" in preparation) return skipped(preparation.reason!);
  try {
    const targets = preparation.targets!;
    if (!targets.length) {
      await withPlatformContext(db, (tx) => finishProviderSyncRun(tx, { id: runId, status: "skipped", errorClass: "no_due_catalog_targets" }));
      return skipped("no_due_catalog_targets");
    }
    const report = await fetchTccCachedMarket(targets, { env, transport: input.transport });
    return await withPlatformContext(db, async (tx) => {
      // An operator pause while TCC is refreshing must still stop SSI ingestion.
      const runtime = await getProviderRuntime(tx, PROVIDER);
      if (!runtime?.enabled || runtime.paused || runtime.mode !== "live") {
        await finishProviderSyncRun(tx, { id: runId, status: "skipped", errorClass: "operator_paused" });
        return skipped("operator_paused");
      }
      let received = 0;
      for (const record of report.records) {
        const [existing] = await tx.select({ payload: tcgMarketIngest.payload }).from(tcgMarketIngest)
          .where(and(eq(tcgMarketIngest.sourceKey, PROVIDER), eq(tcgMarketIngest.sourceRecordId, record.provider_record_id))).limit(1);
        if (existing && existing.payload.price !== record.price) {
          throw new ProviderHttpError({ status: 0, errorClass: "tcc_observation_conflict" });
        }
        // This canonical function already enqueues normalization in this same
        // transaction; do not create a parallel job or double-count a cache hit.
        await receiveTcgMarketRecord(tx, record);
        if (!existing) received += 1;
      }
      const checkpoint = { version: "tcc.market.v1", statuses: report.statuses,
        cache_hits: report.cacheHits, stale_quotes: report.staleQuotes, accepted_quotes: report.records.length,
        requested: targets.length, tcc_catalog_after: targets.at(-1)!.request.request_id };
      const cursor = { ...runtime.cursor, tcc_catalog_after: checkpoint.tcc_catalog_after };
      if (report.records.length) {
        await recordProviderSyncResult(tx, { providerKey: PROVIDER, ok: true, received, cursor,
          healthStatus: report.staleQuotes === report.records.length ? "unknown" : "healthy" });
      } else {
        // A reachable API returning unsupported/missing identities is not proof
        // of a working price feed. Rotate past those targets without inventing quotes.
        await tx.update(providerRuntime).set({ cursor, healthStatus: "unknown", updatedAt: new Date() })
          .where(eq(providerRuntime.providerKey, PROVIDER));
      }
      const status = report.records.length ? "completed" as const : "skipped" as const;
      await finishProviderSyncRun(tx, { id: runId, status, receivedCount: received,
        errorClass: report.records.length ? null : "no_available_quotes", checkpoint });
      return { status, reason: report.records.length ? null : "no_available_quotes", received, quarantined: 0 };
    });
  } catch (error) {
    const errorClass = error instanceof ProviderHttpError ? error.errorClass : "tcc_ingest_failed";
    await withPlatformContext(db, async (tx) => {
      await recordProviderSyncResult(tx, { providerKey: PROVIDER, ok: false, errorClass,
        retryAfterAt: error instanceof ProviderHttpError && error.retryAfterMs ? new Date(Date.now() + error.retryAfterMs) : undefined });
      await finishProviderSyncRun(tx, { id: runId, status: "failed", errorClass });
    });
    return { status: "failed" as const, reason: errorClass, received: 0, quarantined: 0 };
  } finally {
    await withPlatformContext(db, (tx) => releaseProviderLease(tx, PROVIDER));
  }
}
