import { desc, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import {
  creator,
  creatorAuthoritySlice,
  creatorCall,
  creatorCallOutcome,
  creatorTrustEvent,
} from "../schema/creator.js";
import { creatorCallAlpha } from "../schema/analytics.js";
import {
  assignTrustState,
  authorityScore,
  authorityWeight,
  bayesMean,
  mean,
  median,
  priceTier,
  recencyWeight,
  wilsonInterval,
} from "./stats.js";
import { earlyCallScore, printingContext } from "./outcomes.js";
import { ALPHA_METHOD_VERSION } from "../analytics/catalog.js";

export const AUTHORITY_VERSION = "authority.v1";
export const BENCHMARK_REQUIREMENT = "phase_13_language_era_set_tier_index";

export type SliceKey = {
  gameKey: string | null;
  languageCode: string | null;
  setKey: string | null;
  priceTier: string;
  horizonCode: string | null;
};

function keyId(key: SliceKey) {
  return [key.gameKey ?? "*", key.languageCode ?? "*", key.setKey ?? "*", key.priceTier, key.horizonCode ?? "*"].join("|");
}

export async function latestTrustState(db: Database, creatorId: string) {
  const [row] = await db
    .select()
    .from(creatorTrustEvent)
    .where(eq(creatorTrustEvent.creatorId, creatorId))
    .orderBy(desc(creatorTrustEvent.createdAt))
    .limit(1);
  return row?.trustState ?? null;
}

export async function recordCreatorTrust(
  db: Database,
  input: { creatorId: string; trustState: string; reason?: string },
) {
  await db.insert(creatorTrustEvent).values({
    id: crypto.randomUUID(),
    creatorId: input.creatorId,
    trustState: input.trustState,
    reason: input.reason ?? null,
  });
}

export async function recomputeCreatorAuthority(db: Database, creatorId: string, asOf = new Date()) {
  const excluded = (await latestTrustState(db, creatorId)) === "excluded";
  const rows = await db
    .select({ call: creatorCall, outcome: creatorCallOutcome })
    .from(creatorCall)
    .innerJoin(creatorCallOutcome, eq(creatorCallOutcome.callId, creatorCall.id))
    .where(eq(creatorCall.creatorId, creatorId));
  const usable = rows.filter(
    (row) =>
      row.outcome.evaluationStatus === "evaluated" &&
      row.call.printingId &&
      (row.call.resolutionStatus === "exact" || row.call.resolutionStatus === "high_confidence"),
  );
  const alphaRows = await db.select().from(creatorCallAlpha);
  const alphaByCall = new Map(
    alphaRows
      .filter((row) => row.methodVersion === ALPHA_METHOD_VERSION)
      .map((row) => [row.callId, row]),
  );
  const buckets = new Map<string, typeof usable>();
  const allKey = keyId({
    gameKey: null,
    languageCode: null,
    setKey: null,
    priceTier: "all",
    horizonCode: null,
  });
  buckets.set(allKey, usable);
  for (const row of usable) {
    const ctx = await printingContext(db, row.call.printingId!);
    const slice: SliceKey = {
      gameKey: ctx?.gameKey ?? null,
      languageCode: ctx?.languageCode ?? null,
      setKey: ctx?.setKey ?? null,
      priceTier: priceTier(row.call.priceAtCall == null ? null : Number(row.call.priceAtCall)),
      horizonCode: row.call.horizonCode,
    };
    const id = keyId(slice);
    buckets.set(id, [...(buckets.get(id) ?? []), row]);
    const langKey = keyId({ ...slice, setKey: null, priceTier: "all", horizonCode: null });
    buckets.set(langKey, [...(buckets.get(langKey) ?? []), row]);
  }

  const snapshots = [];
  for (const [id, members] of buckets) {
    const parts = id.split("|");
    const directional = members.filter((row) => row.outcome.directionalCorrect === "correct" || row.outcome.directionalCorrect === "incorrect");
    const successes = directional.filter((row) => row.outcome.directionalCorrect === "correct").length;
    const n = directional.length;
    if (n === 0 && members.length === 0) {
      continue;
    }
    const wilson = wilsonInterval(successes, n);
    const bayes = bayesMean(successes, n);
    const returns = members.map((row) => Number(row.outcome.returnPct)).filter((value) => Number.isFinite(value));
    const relative = members
      .map((row) => Number(alphaByCall.get(row.call.id)?.relativeReturn))
      .filter((value) => Number.isFinite(value));
    const recency = directional.map((row) => {
      const age = (asOf.getTime() - row.call.publishedAt.getTime()) / 86400000;
      const w = recencyWeight(age);
      return { w, hit: row.outcome.directionalCorrect === "correct" ? 1 : 0 };
    });
    const recencyAcc =
      recency.length === 0 ? null : recency.reduce((sum, row) => sum + row.w * row.hit, 0) / recency.reduce((sum, row) => sum + row.w, 0);
    const stated = members.filter((row) => row.call.statedConfidence != null && (row.outcome.directionalCorrect === "correct" || row.outcome.directionalCorrect === "incorrect"));
    const calibration =
      stated.length === 0
        ? null
        : mean(
            stated.map((row) => {
              const y = row.outcome.directionalCorrect === "correct" ? 1 : 0;
              const p = Number(row.call.statedConfidence);
              return (p - y) ** 2;
            }),
          );
    let early: number | null = null;
    const earlyScores = [];
    for (const row of members) {
      if (row.call.printingId && row.call.priceAtCall && row.outcome.returnPct != null) {
        const result = await earlyCallScore(db, {
          printingId: row.call.printingId,
          publishedAt: row.call.publishedAt,
          startPrice: Number(row.call.priceAtCall),
          horizonReturn: Number(row.outcome.returnPct),
        });
        if (result.score != null) {
          earlyScores.push(result.score);
        }
      }
    }
    early = mean(earlyScores);
    const trust = assignTrustState({ n, wilsonLow: wilson.low, excluded });
    const score = authorityScore({ wilsonLow: wilson.low, n, avgReturn: mean(returns) });
    const weight = authorityWeight({ n, trustState: trust, wilsonLow: wilson.low });
    const snapshot = {
      id: crypto.randomUUID(),
      creatorId,
      gameKey: parts[0] === "*" ? null : parts[0]!,
      languageCode: parts[1] === "*" ? null : parts[1]!,
      era: "unspecified",
      setKey: parts[2] === "*" ? null : parts[2]!,
      priceTier: parts[3]!,
      horizonCode: parts[4] === "*" ? null : parts[4]!,
      rawGraded: "raw",
      sampleSize: String(n),
      successes: String(successes),
      rawAccuracy: n ? wilson.raw.toFixed(6) : null,
      recencyWeightedAccuracy: recencyAcc == null ? null : recencyAcc.toFixed(6),
      wilsonLow: n ? wilson.low.toFixed(6) : null,
      wilsonCenter: n ? wilson.center.toFixed(6) : null,
      wilsonHigh: n ? wilson.high.toFixed(6) : null,
      bayesMean: n ? bayes.toFixed(6) : null,
      avgReturn: mean(returns) == null ? null : mean(returns)!.toFixed(6),
      medianReturn: median(returns) == null ? null : median(returns)!.toFixed(6),
      avgRelativeReturn: mean(relative) == null ? null : mean(relative)!.toFixed(6),
      avgMfe: mean(members.map((row) => Number(row.outcome.maxFavorableExcursion)).filter(Number.isFinite))?.toFixed(6) ?? null,
      avgMae: mean(members.map((row) => Number(row.outcome.maxAdverseExcursion)).filter(Number.isFinite))?.toFixed(6) ?? null,
      earlyCallScore: early == null ? null : early.toFixed(6),
      calibrationError: calibration == null ? null : calibration.toFixed(6),
      authorityScore: score.toFixed(4),
      authorityWeight: weight.toFixed(6),
      trustState: trust,
      formulaVersion: AUTHORITY_VERSION,
      benchmarkRequirement: BENCHMARK_REQUIREMENT,
      components: {
        wilson,
        bayes_prior: { alpha: 8, beta: 8 },
        sample_shrinkage: "n/(n+20)",
        ranking_stat: "wilson_low",
        buy_sell_signal: false,
        unresolved_excluded: true,
        recency_half_life_days: 180,
        early_call_version: "early_call.v1",
      },
    };
    await db.insert(creatorAuthoritySlice).values(snapshot);
    snapshots.push(snapshot);
  }
  return snapshots;
}

export async function getCreatorAuthorityProfile(db: Database, creatorId: string) {
  const [creatorRow] = await db.select().from(creator).where(eq(creator.id, creatorId)).limit(1);
  const calls = await db.select().from(creatorCall).where(eq(creatorCall.creatorId, creatorId));
  const outcomes = await db.select().from(creatorCallOutcome);
  const joined = calls.map((call) => ({
    call,
    outcome: outcomes.find((row) => row.callId === call.id) ?? null,
  }));
  const slices = await db
    .select()
    .from(creatorAuthoritySlice)
    .where(eq(creatorAuthoritySlice.creatorId, creatorId))
    .orderBy(desc(creatorAuthoritySlice.createdAt));
  const evaluated = joined.filter((row) => row.outcome?.evaluationStatus === "evaluated");
  const returns = evaluated.map((row) => Number(row.outcome?.returnPct)).filter((value) => Number.isFinite(value));
  const best = evaluated.reduce<(typeof evaluated)[number] | null>((acc, row) => {
    if (!acc) return row;
    return Number(row.outcome?.returnPct) > Number(acc.outcome?.returnPct) ? row : acc;
  }, null);
  const worst = evaluated.reduce<(typeof evaluated)[number] | null>((acc, row) => {
    if (!acc) return row;
    return Number(row.outcome?.returnPct) < Number(acc.outcome?.returnPct) ? row : acc;
  }, null);
  const headline = slices.find((row) => row.priceTier === "all" && row.gameKey == null) ?? slices[0] ?? null;
  return {
    creator: creatorRow,
    trustState: (await latestTrustState(db, creatorId)) ?? headline?.trustState ?? "low_confidence",
    totalCalls: calls.length,
    resolved: evaluated.length,
    unresolved: calls.filter((row) => row.printingId == null).length,
    awaitingOutcome: joined.filter((row) => row.outcome?.evaluationStatus === "pending").length,
    averageReturn: mean(returns),
    medianReturn: median(returns),
    bestCall: best?.call ?? null,
    worstCall: worst?.call ?? null,
    headline,
    slices,
    historicalCalls: joined,
    buySellSignal: false,
  };
}
