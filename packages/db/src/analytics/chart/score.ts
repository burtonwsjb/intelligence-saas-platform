/**
 * Chart Sentiment for one segment's daily series: which catalog patterns fire
 * on the latest day, weighted by how often each pattern has been right on our
 * own card history, combined into a -100..+100 score with a label and a
 * confidence. Also the look-ahead-free backtest that measures those hit rates.
 */
import { buildChartContext, CHART_PATTERNS, type ChartContext, type ChartPatternDef } from "./patterns.js";
import type { ChartSeries, DailyPoint } from "./series.js";

export const CHART_METHOD_VERSION = "chart-sentiment.v1";

export const CHART_SCORE_RULES = {
  /** Fewer daily points than this and no score is given. */
  minPoints: 30,
  /** Score at or above this is bullish, at or below its negative bearish. */
  labelThreshold: 25,
  /**
   * The score is net / max(gross, floor x the weight of every pattern group the
   * data could evaluate), so one weak signal among many silent ones stays near neutral.
   */
  denominatorFloorShare: 0.35,
  /** Pseudo-samples of the prior hit rate blended with measured samples. */
  priorStrength: 30,
  /** A forward move smaller than this is "flat" and not a sample. */
  hitMinMove: 0.01,
  /** Full coverage confidence at this many points. */
  fullCoveragePoints: 200,
  /** Data newer than this many days is fresh; confidence reaches 0 at staleDays. */
  freshDays: 3,
  staleDays: 30,
  /** Signals listed per segment. */
  maxSignals: 8,
} as const;

const R = CHART_SCORE_RULES;

export type PatternStats = { samples: number; hits: number };
export type PatternStatsMap = ReadonlyMap<string, PatternStats>;

export type ChartLabel = "bullish" | "neutral" | "bearish" | "insufficient_history";

export type ChartSignal = {
  key: string;
  name: string;
  direction: "bullish" | "bearish";
  strength: number;
  /** Signed share of the score this signal contributed, -100..100. */
  contribution: number;
  /** Hit rate used for the weight (measured, blended with the prior). */
  hitRate: number;
  samples: number;
  detail: string;
};

export type ChartInsufficient = { key: string; reason: "needs_points" | "needs_sales" | "needs_listings" | "needs_population"; needs?: number };

export type ChartSegmentResult = {
  segment: string;
  gradingCompany: string | null;
  grade: string | null;
  currency: string | null;
  priceType: string | null;
  points: number;
  dataFrom: string | null;
  dataThrough: string | null;
  lastPrice: number | null;
  score: number | null;
  label: ChartLabel;
  confidence: number;
  signals: ChartSignal[];
  insufficient: ChartInsufficient[];
  inputs: {
    change30dPct: number | null;
    sales30d: number | null;
    listingsLatest: number | null;
    populationLatest: number | null;
    filledDays: number;
    otherCurrencyRows: number;
  };
};

export type ChartBacktest = Record<string, { samples: number; hits: number; flat: number }>;

/** Measured hit rate blended with the pattern's prior. */
export function blendedHitRate(pattern: Pick<ChartPatternDef, "priorHitRate">, stats: PatternStats | undefined): number {
  const samples = stats?.samples ?? 0;
  const hits = stats?.hits ?? 0;
  return (hits + R.priorStrength * pattern.priorHitRate) / (samples + R.priorStrength);
}

/** 0 for a coin flip or worse, 1 for a pattern that is always right. */
export function reliability(hitRate: number): number {
  return Math.max(0, Math.min(1, (hitRate - 0.5) / 0.5));
}

function hasData(values: readonly (number | null)[], from: number, to: number) {
  for (let i = Math.max(0, from); i <= to; i += 1) if (values[i] != null) return true;
  return false;
}

/** Whether the pattern can be read at day t, or why not. */
function evaluable(pattern: ChartPatternDef, ctx: ChartContext, t: number): ChartInsufficient | null {
  if (t + 1 < pattern.minPoints) return { key: pattern.key, reason: "needs_points", needs: pattern.minPoints };
  if (pattern.requires) {
    const values = ctx[pattern.requires === "sales" ? "sales" : pattern.requires === "listings" ? "listings" : "population"];
    if (!hasData(values, t - pattern.minPoints + 1, t)) {
      return { key: pattern.key, reason: `needs_${pattern.requires}` as ChartInsufficient["reason"] };
    }
  }
  return null;
}

function round(value: number, places: number) {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

function daysBetween(a: string, b: Date) {
  return Math.floor((b.getTime() - Date.parse(`${a}T00:00:00.000Z`)) / 86_400_000);
}

function inputsOf(points: readonly DailyPoint[], otherCurrencyRows: number): ChartSegmentResult["inputs"] {
  const last = points[points.length - 1];
  const before = points.length > 30 ? points[points.length - 31] : null;
  const recent = points.slice(-30);
  const sales = recent.filter((p) => p.sales != null);
  const listing = [...points].reverse().find((p) => p.listings != null);
  const population = [...points].reverse().find((p) => p.population != null);
  return {
    change30dPct: last && before ? round((last.price / before.price - 1) * 100, 2) : null,
    sales30d: sales.length ? sales.reduce((sum, p) => sum + p.sales!, 0) : null,
    listingsLatest: listing?.listings ?? null,
    populationLatest: population?.population ?? null,
    filledDays: points.filter((p) => p.filled).length,
    otherCurrencyRows,
  };
}

/** Scores the latest day of one segment's series. */
export function scoreChartSeries(series: ChartSeries, stats: PatternStatsMap, now: Date = new Date()): ChartSegmentResult {
  const points = series.points;
  const base: ChartSegmentResult = {
    segment: series.segment,
    gradingCompany: series.gradingCompany,
    grade: series.grade,
    currency: series.currency,
    priceType: series.priceType,
    points: points.length,
    dataFrom: points[0]?.day ?? null,
    dataThrough: points[points.length - 1]?.day ?? null,
    lastPrice: points[points.length - 1]?.price ?? null,
    score: null,
    label: "insufficient_history",
    confidence: 0,
    signals: [],
    insufficient: [],
    inputs: inputsOf(points, series.otherCurrencyRows),
  };
  if (points.length < R.minPoints) {
    base.insufficient = CHART_PATTERNS.map((p) => ({ key: p.key, reason: "needs_points" as const, needs: Math.max(p.minPoints, R.minPoints) }));
    return base;
  }
  const ctx = buildChartContext(points);
  const t = points.length - 1;
  const groupWeight = new Map<string, number>();
  const fired: Array<{ pattern: ChartPatternDef; strength: number; weight: number; hitRate: number; samples: number; detail: string }> = [];
  for (const pattern of CHART_PATTERNS) {
    const missing = evaluable(pattern, ctx, t);
    if (missing) {
      base.insufficient.push(missing);
      continue;
    }
    const hitRate = blendedHitRate(pattern, stats.get(pattern.key));
    const weight = pattern.baseWeight * reliability(hitRate);
    groupWeight.set(pattern.group, Math.max(groupWeight.get(pattern.group) ?? 0, weight));
    const hit = pattern.detect(ctx, t);
    if (hit) fired.push({ pattern, strength: hit.strength, weight, hitRate, samples: stats.get(pattern.key)?.samples ?? 0, detail: hit.detail });
  }
  const sign = (p: ChartPatternDef) => (p.direction === "bullish" ? 1 : -1);
  const net = fired.reduce((sum, f) => sum + sign(f.pattern) * f.strength * f.weight, 0);
  const gross = fired.reduce((sum, f) => sum + f.strength * f.weight, 0);
  const available = [...groupWeight.values()].reduce((sum, w) => sum + w, 0);
  const denominator = Math.max(gross, R.denominatorFloorShare * available);
  const score = denominator > 0 ? Math.round(Math.max(-100, Math.min(100, (100 * net) / denominator))) : 0;
  base.score = score;
  base.label = score >= R.labelThreshold ? "bullish" : score <= -R.labelThreshold ? "bearish" : "neutral";
  base.signals = fired
    .map((f) => ({
      key: f.pattern.key,
      name: f.pattern.name,
      direction: f.pattern.direction,
      strength: round(f.strength, 3),
      contribution: denominator > 0 ? round((100 * sign(f.pattern) * f.strength * f.weight) / denominator, 1) : 0,
      hitRate: round(f.hitRate, 4),
      samples: f.samples,
      detail: f.detail,
    }))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution) || a.key.localeCompare(b.key))
    .slice(0, R.maxSignals);
  // Confidence: history length x agreement among firing signals x freshness.
  const coverage = Math.sqrt(Math.min(1, points.length / R.fullCoveragePoints));
  const agreement = gross > 0 ? Math.abs(net) / gross : 0;
  const age = base.dataThrough ? daysBetween(base.dataThrough, now) : R.staleDays;
  const freshness = age <= R.freshDays ? 1 : Math.max(0, 1 - (age - R.freshDays) / (R.staleDays - R.freshDays));
  base.confidence = round(coverage * (0.5 + 0.5 * agreement) * freshness, 3);
  return base;
}

export function confidenceLabel(confidence: number): "high" | "medium" | "low" {
  return confidence >= 0.66 ? "high" : confidence >= 0.33 ? "medium" : "low";
}

/**
 * Replays every pattern over the series without look-ahead: at each day t a
 * pattern that fires is judged by the close `horizonDays` later. A move in the
 * signalled direction of at least hitMinMove is a hit, the other way a miss,
 * anything smaller is flat (not a sample). After a pattern fires it is not
 * counted again until its horizon has passed, so samples do not overlap.
 */
export function backtestChartSeries(series: Pick<ChartSeries, "points">): ChartBacktest {
  const points = series.points;
  const out: ChartBacktest = {};
  if (points.length < R.minPoints) return out;
  const ctx = buildChartContext(points);
  for (const pattern of CHART_PATTERNS) {
    const tally = { samples: 0, hits: 0, flat: 0 };
    const first = Math.max(pattern.minPoints, R.minPoints) - 1;
    for (let t = first; t + pattern.horizonDays < points.length; t += 1) {
      if (evaluable(pattern, ctx, t)) continue;
      if (!pattern.detect(ctx, t)) continue;
      const move = ctx.close[t + pattern.horizonDays]! / ctx.close[t]! - 1;
      if (Math.abs(move) < R.hitMinMove) tally.flat += 1;
      else {
        tally.samples += 1;
        if ((pattern.direction === "bullish") === move > 0) tally.hits += 1;
      }
      t += pattern.horizonDays - 1;
    }
    if (tally.samples || tally.flat) out[pattern.key] = tally;
  }
  return out;
}

/** Sums backtests (e.g. over every stored segment) into pattern stats. */
export function sumBacktests(backtests: Iterable<ChartBacktest>): Map<string, { samples: number; hits: number; flat: number }> {
  const out = new Map<string, { samples: number; hits: number; flat: number }>();
  for (const backtest of backtests) {
    for (const [key, value] of Object.entries(backtest)) {
      const sum = out.get(key) ?? { samples: 0, hits: 0, flat: 0 };
      sum.samples += value.samples;
      sum.hits += value.hits;
      sum.flat += value.flat;
      out.set(key, sum);
    }
  }
  return out;
}
