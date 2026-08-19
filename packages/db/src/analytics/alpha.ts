import { and, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { creatorCall, creatorCallOutcome } from "../schema/creator.js";
import { creatorCallAlpha } from "../schema/analytics.js";
import { ALPHA_METHOD_VERSION, MS_DAY } from "./catalog.js";
import { printingBenchmarkContext, resolveBenchmark } from "./benchmark.js";
import { getIndexLevelAsOf, indexReturn } from "./index-engine.js";
import { horizonDays } from "../creator/outcomes.js";

export async function getCreatorCallAlpha(
  db: Database,
  callId: string,
  methodVersion = ALPHA_METHOD_VERSION,
) {
  const [row] = await db
    .select()
    .from(creatorCallAlpha)
    .where(and(eq(creatorCallAlpha.callId, callId), eq(creatorCallAlpha.methodVersion, methodVersion)))
    .limit(1);
  return row ?? null;
}

export async function computeCreatorAlpha(db: Database, callId: string, asOf = new Date()) {
  const existing = await getCreatorCallAlpha(db, callId);
  if (existing) {
    return existing;
  }
  const [call] = await db.select().from(creatorCall).where(eq(creatorCall.id, callId)).limit(1);
  const [outcome] = await db.select().from(creatorCallOutcome).where(eq(creatorCallOutcome.callId, callId)).limit(1);
  if (!call || !outcome) {
    throw new Error("creator call or outcome not found.");
  }

  const fail = async (dataQuality: string, components: Record<string, unknown> = {}) => {
    const [row] = await db
      .insert(creatorCallAlpha)
      .values({
        id: crypto.randomUUID(),
        callId,
        methodVersion: ALPHA_METHOD_VERSION,
        cardReturn: outcome.returnPct,
        benchmarkIndexKey: null,
        benchmarkReturn: null,
        relativeReturn: null,
        benchmarkLevelAtCall: null,
        benchmarkLevelAtHorizon: null,
        dataQuality,
        components: { method: ALPHA_METHOD_VERSION, ...components },
      })
      .returning();
    return row!;
  };

  if (outcome.evaluationStatus !== "evaluated" || outcome.returnPct == null || !call.printingId) {
    return fail("insufficient_outcome");
  }
  const days = horizonDays(call.horizonCode, call.horizonCustomDays);
  if (days == null) {
    return fail("missing_horizon");
  }
  const horizonAt = new Date(call.publishedAt.getTime() + days * MS_DAY);
  if (asOf.getTime() < horizonAt.getTime()) {
    return fail("horizon_not_elapsed");
  }
  const ctx = await printingBenchmarkContext(db, call.printingId);
  if (!ctx) {
    return fail("missing_printing_context");
  }
  const resolved = await resolveBenchmark(db, {
    printingId: call.printingId,
    gameKey: ctx.gameKey,
    languageCode: ctx.languageCode,
    setKey: ctx.setKey,
    era: "modern",
    asOf: call.publishedAt,
  });
  if (resolved.status !== "ok" || !resolved.indexKey) {
    return fail("insufficient_benchmark", { resolver: resolved });
  }
  const startLevel = await getIndexLevelAsOf(db, resolved.indexKey, call.publishedAt);
  const endLevel = await getIndexLevelAsOf(db, resolved.indexKey, horizonAt);
  if (!startLevel || !endLevel) {
    return fail("insufficient_benchmark_levels", { index_key: resolved.indexKey });
  }
  const start = Number(startLevel.indexValue);
  const end = Number(endLevel.indexValue);
  const bench = indexReturn(start, end);
  if (!Number.isFinite(bench)) {
    return fail("insufficient_benchmark_levels", { index_key: resolved.indexKey });
  }
  const card = Number(outcome.returnPct);
  const alpha = card - bench;
  const [row] = await db
    .insert(creatorCallAlpha)
    .values({
      id: crypto.randomUUID(),
      callId,
      methodVersion: ALPHA_METHOD_VERSION,
      cardReturn: card.toFixed(6),
      benchmarkIndexKey: resolved.indexKey,
      benchmarkReturn: bench.toFixed(6),
      relativeReturn: alpha.toFixed(6),
      benchmarkLevelAtCall: startLevel.indexValue,
      benchmarkLevelAtHorizon: endLevel.indexValue,
      dataQuality: "complete",
      components: {
        method: ALPHA_METHOD_VERSION,
        formula: "card_return - benchmark_return",
        resolver: resolved,
        look_ahead: false,
        raw_outcome_rewritten: false,
      },
    })
    .returning();
  return row!;
}
