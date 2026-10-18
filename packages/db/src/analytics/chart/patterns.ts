/**
 * The chart pattern catalog: standard chart-reading rules (moving-average
 * trend and crossovers, RSI and MACD momentum, support/resistance breakouts,
 * double tops and bottoms, head and shoulders, Bollinger bands, volume
 * confirmation, demand, supply and population). Each pattern has a fixed
 * direction, the horizon its call is judged over, the history it needs, a
 * base weight and a prior hit rate used until our own card history has
 * measured it. Every threshold is an explicit constant below.
 *
 * Detectors read a precomputed context at day index t and use only data at
 * indices <= t, so the same code scores today and backtests the past.
 */
import { bollinger, macd, pivots, rsi, sma, type Line } from "./indicators.js";
import type { DailyPoint } from "./series.js";

export const CHART_CATALOG_VERSION = "chart-patterns.v1";

export const CHART_THRESHOLDS = {
  /** Moving averages. */
  maShort: 20,
  maMedium: 50,
  maLong: 200,
  /** A crossover counts for this many days after it happens. */
  crossRecentDays: 10,
  /** Trend: the 50-day average must have risen (fallen) over this many days. */
  trendSlopeDays: 10,
  /** Trend strength reaches 1 when the 20-day average is this far above (below) the 50-day. */
  trendFullSpread: 0.05,
  rsiPeriod: 14,
  rsiOversold: 30,
  rsiOverbought: 70,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  /** A MACD crossover counts for this many days after it happens. */
  macdRecentDays: 5,
  /** Support/resistance: the level is the extreme close of this many days before the breakout window. */
  levelWindowDays: 30,
  /** The breakout must have happened within this many days. */
  breakoutRecentDays: 3,
  /** A breakout must clear the level by this fraction. */
  breakoutMargin: 0.02,
  /** Closes within this fraction of the level count as a test of it; at least levelMinTests are needed. */
  levelTouchBand: 0.02,
  levelMinTests: 2,
  /** Volume confirmation: average sales of the last volumeRecentDays vs the volumeBaseDays before. */
  volumeRecentDays: 5,
  volumeBaseDays: 30,
  volumeConfirmRatio: 1.5,
  /** Pivots: a turning point must be the extreme of this many days on each side. */
  pivotSpan: 3,
  /** Double top/bottom. */
  doubleWindowDays: 60,
  doubleLevelTolerance: 0.03,
  doubleMinSeparationDays: 10,
  doubleMinRetrace: 0.05,
  /** The neckline break must be this recent. */
  confirmRecentDays: 5,
  /** Head and shoulders. */
  hsWindowDays: 90,
  hsHeadOverShoulders: 0.03,
  hsShoulderTolerance: 0.05,
  hsMinSpacingDays: 5,
  bollingerPeriod: 20,
  bollingerWidth: 2,
  /** Demand/supply: the last demandRecentDays vs the demandBaseDays before them. */
  demandRecentDays: 14,
  demandBaseDays: 30,
  demandRiseRatio: 1.25,
  demandFallRatio: 0.75,
  /** Share of days in the comparison windows that must report the measure. */
  demandMinCoverage: 0.3,
  /** Population growth over populationLookbackDays that counts as new supply. */
  populationLookbackDays: 90,
  populationGrowth: 0.1,
} as const;

const T = CHART_THRESHOLDS;

export type ChartDirection = "bullish" | "bearish";
export type ChartCategory = "trend" | "momentum" | "levels" | "reversal" | "volatility" | "demand" | "population";
export type ChartRequirement = "sales" | "listings" | "population";

export type ChartContext = {
  close: number[];
  sales: (number | null)[];
  listings: (number | null)[];
  population: (number | null)[];
  maShort: Line;
  maMedium: Line;
  maLong: Line;
  rsi: Line;
  macd: Line;
  macdSignal: Line;
  bbUpper: Line;
  bbLower: Line;
  pivotHighs: number[];
  pivotLows: number[];
};

export type PatternHit = { strength: number; detail: string };

export type ChartPatternDef = {
  key: string;
  name: string;
  category: ChartCategory;
  direction: ChartDirection;
  /** Days after the signal over which the move is judged. */
  horizonDays: number;
  /** Daily points needed before the rule can be read. */
  minPoints: number;
  /** Data beyond price the rule needs. */
  requires?: ChartRequirement;
  baseWeight: number;
  /** Hit rate assumed before our card history has measured the pattern. */
  priorHitRate: number;
  /** Mutually exclusive patterns share a group; a group's weight counts once. */
  group: string;
  rule: string;
  explanation: string;
  detect: (ctx: ChartContext, t: number) => PatternHit | null;
};

export function buildChartContext(points: readonly DailyPoint[]): ChartContext {
  const close = points.map((point) => point.price);
  const m = macd(close, T.macdFast, T.macdSlow, T.macdSignal);
  const bands = bollinger(close, T.bollingerPeriod, T.bollingerWidth);
  const turns = pivots(close, T.pivotSpan);
  return {
    close,
    sales: points.map((point) => point.sales),
    listings: points.map((point) => point.listings),
    population: points.map((point) => point.population),
    maShort: sma(close, T.maShort),
    maMedium: sma(close, T.maMedium),
    maLong: sma(close, T.maLong),
    rsi: rsi(close, T.rsiPeriod),
    macd: m.line,
    macdSignal: m.signal,
    bbUpper: bands.upper,
    bbLower: bands.lower,
    pivotHighs: turns.highs,
    pivotLows: turns.lows,
  };
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

/** a - b, with float noise (relative 1e-9) read as exactly equal. */
function diff(a: number, b: number): number {
  const d = a - b;
  return Math.abs(d) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)) ? 0 : d;
}

/** Days back (0 = today) since `a` last crossed above (`up`) or below `b`, within `within` days. */
function crossedWithin(a: Line, b: Line, t: number, within: number, up: boolean): number | null {
  for (let k = t; k > t - within && k >= 1; k -= 1) {
    const a0 = a[k - 1], b0 = b[k - 1], a1 = a[k], b1 = b[k];
    if (a0 == null || b0 == null || a1 == null || b1 == null) return null;
    const before = diff(a0, b0), after = diff(a1, b1);
    if (up ? before <= 0 && after > 0 : before >= 0 && after < 0) return t - k;
  }
  return null;
}

function maCross(up: boolean) {
  return (ctx: ChartContext, t: number): PatternHit | null => {
    const fast = ctx.maMedium[t], slow = ctx.maLong[t];
    if (fast == null || slow == null || (up ? fast <= slow : fast >= slow)) return null;
    const ago = crossedWithin(ctx.maMedium, ctx.maLong, t, T.crossRecentDays, up);
    if (ago == null) return null;
    return {
      strength: clamp01(1 - (ago / T.crossRecentDays) * 0.5),
      detail: `50-day average crossed ${up ? "above" : "below"} the 200-day average ${ago === 0 ? "today" : `${ago} day${ago === 1 ? "" : "s"} ago`}.`,
    };
  };
}

function trend(up: boolean) {
  return (ctx: ChartContext, t: number): PatternHit | null => {
    const price = ctx.close[t]!, short = ctx.maShort[t], medium = ctx.maMedium[t], before = ctx.maMedium[t - T.trendSlopeDays];
    if (short == null || medium == null || before == null) return null;
    const aligned = up ? price > short && short > medium && medium > before : price < short && short < medium && medium < before;
    if (!aligned) return null;
    const spread = Math.abs(short / medium - 1);
    return {
      strength: clamp01(0.3 + 0.7 * (spread / T.trendFullSpread)),
      detail: `Price ${up ? "above" : "below"} the 20-day average, which is ${pct(spread)} ${up ? "above" : "below"} a ${up ? "rising" : "falling"} 50-day average.`,
    };
  };
}

function rsiExtreme(oversold: boolean) {
  return (ctx: ChartContext, t: number): PatternHit | null => {
    const value = ctx.rsi[t];
    if (value == null) return null;
    if (oversold ? value >= T.rsiOversold : value <= T.rsiOverbought) return null;
    const depth = oversold ? (T.rsiOversold - value) / T.rsiOversold : (value - T.rsiOverbought) / (100 - T.rsiOverbought);
    return { strength: clamp01(0.4 + depth), detail: `RSI(14) is ${value.toFixed(0)}, ${oversold ? "below 30 (oversold)" : "above 70 (overbought)"}.` };
  };
}

function macdCross(up: boolean) {
  return (ctx: ChartContext, t: number): PatternHit | null => {
    const line = ctx.macd[t], signal = ctx.macdSignal[t];
    if (line == null || signal == null || (up ? diff(line, signal) <= 0 : diff(line, signal) >= 0)) return null;
    const ago = crossedWithin(ctx.macd, ctx.macdSignal, t, T.macdRecentDays, up);
    if (ago == null) return null;
    // A bullish cross below zero (or bearish above zero) is the classic, stronger reading.
    const fromExtreme = up ? line < 0 : line > 0;
    return {
      strength: clamp01((fromExtreme ? 1 : 0.6) - (ago / T.macdRecentDays) * 0.3),
      detail: `MACD crossed ${up ? "above" : "below"} its signal line ${ago === 0 ? "today" : `${ago} day${ago === 1 ? "" : "s"} ago`}${fromExtreme ? (up ? ", from below zero" : ", from above zero") : ""}.`,
    };
  };
}

function average(values: readonly (number | null)[], from: number, to: number): { mean: number | null; coverage: number } {
  let sum = 0, count = 0;
  const lo = Math.max(0, from);
  for (let i = lo; i <= to; i += 1) {
    const value = values[i];
    if (value != null) {
      sum += value;
      count += 1;
    }
  }
  const span = to - lo + 1;
  return { mean: count ? sum / count : null, coverage: span > 0 ? count / span : 0 };
}

/** Volume confirmation for a breakout: 1 when sales jumped, 0.5 when sales are known but flat, 0.75 when unknown. */
function volumeFactor(ctx: ChartContext, t: number): { factor: number; note: string } {
  const recent = average(ctx.sales, t - T.volumeRecentDays + 1, t);
  const base = average(ctx.sales, t - T.volumeRecentDays - T.volumeBaseDays + 1, t - T.volumeRecentDays);
  if (recent.mean == null || base.mean == null || base.coverage < T.demandMinCoverage) {
    return { factor: 0.75, note: "No sales volume to confirm it." };
  }
  if (base.mean > 0 && recent.mean / base.mean >= T.volumeConfirmRatio) {
    return { factor: 1, note: `Confirmed by volume: sales ${(recent.mean / base.mean).toFixed(1)}x their recent average.` };
  }
  return { factor: 0.5, note: "Not confirmed by volume." };
}

function breakout(up: boolean) {
  return (ctx: ChartContext, t: number): PatternHit | null => {
    // The level is the extreme close of the levelWindowDays ending the day
    // before `anchor`; `anchor` is breakoutRecentDays before today.
    const anchor = t - T.breakoutRecentDays;
    const end = anchor - 1;
    const start = end - T.levelWindowDays + 1;
    if (start < 0) return null;
    let level = up ? -Infinity : Infinity;
    for (let i = start; i <= end; i += 1) level = up ? Math.max(level, ctx.close[i]!) : Math.min(level, ctx.close[i]!);
    let tests = 0;
    for (let i = start; i <= end; i += 1) if (Math.abs(ctx.close[i]! / level - 1) <= T.levelTouchBand) tests += 1;
    if (tests < T.levelMinTests) return null;
    const price = ctx.close[t]!;
    const cleared = up ? price >= level * (1 + T.breakoutMargin) : price <= level * (1 - T.breakoutMargin);
    // Fresh: the price was still at or inside the level on the anchor day, so
    // the break happened within the last breakoutRecentDays.
    const fresh = up ? ctx.close[anchor]! <= level : ctx.close[anchor]! >= level;
    if (!cleared || !fresh) return null;
    const volume = volumeFactor(ctx, t);
    const move = Math.abs(price / level - 1);
    return {
      strength: clamp01((0.5 + move / (T.breakoutMargin * 5)) * volume.factor),
      detail: `Price ${up ? "broke above resistance" : "broke below support"} at ${level.toFixed(2)} (${pct(move)} through it). ${volume.note}`,
    };
  };
}

function lastBefore(indices: readonly number[], limit: number): number {
  // Index into `indices` of the last pivot at or before `limit`, or -1.
  let lo = 0, hi = indices.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (indices[mid]! <= limit) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

function brokeWithin(ctx: ChartContext, t: number, level: number, up: boolean): boolean {
  if (up ? ctx.close[t]! <= level : ctx.close[t]! >= level) return false;
  for (let k = t - 1; k >= t - T.confirmRecentDays && k >= 0; k -= 1) {
    if (up ? ctx.close[k]! <= level : ctx.close[k]! >= level) return true;
  }
  return false;
}

/** Double bottom (bullish, `bottom` true) or double top. */
function double(bottom: boolean) {
  return (ctx: ChartContext, t: number): PatternHit | null => {
    const turns = bottom ? ctx.pivotLows : ctx.pivotHighs;
    const lastIndex = lastBefore(turns, t - T.pivotSpan);
    if (lastIndex < 1) return null;
    const second = turns[lastIndex]!;
    for (let j = lastIndex - 1; j >= 0; j -= 1) {
      const first = turns[j]!;
      if (first < t - T.doubleWindowDays) break;
      if (second - first < T.doubleMinSeparationDays) continue;
      const a = ctx.close[first]!, b = ctx.close[second]!;
      if (Math.abs(a / b - 1) > T.doubleLevelTolerance) continue;
      // The neckline is the opposite extreme between the two turns.
      let neck = bottom ? -Infinity : Infinity;
      for (let i = first + 1; i < second; i += 1) neck = bottom ? Math.max(neck, ctx.close[i]!) : Math.min(neck, ctx.close[i]!);
      const extreme = bottom ? Math.min(a, b) : Math.max(a, b);
      const retrace = Math.abs(neck / extreme - 1);
      if (retrace < T.doubleMinRetrace) continue;
      // Neither turn may be undercut (overshot) after the second one.
      let intact = true;
      for (let i = second + 1; i <= t; i += 1) {
        if (bottom ? ctx.close[i]! < extreme * (1 - T.doubleLevelTolerance) : ctx.close[i]! > extreme * (1 + T.doubleLevelTolerance)) intact = false;
      }
      if (!intact || !brokeWithin(ctx, t, neck, bottom)) continue;
      return {
        strength: clamp01(0.4 + retrace / 0.25),
        detail: `Two ${bottom ? "lows" : "highs"} near ${extreme.toFixed(2)} ${second - first} days apart, then price ${bottom ? "rose above" : "fell below"} the ${neck.toFixed(2)} neckline.`,
      };
    }
    return null;
  };
}

/** Head and shoulders (bearish, `inverse` false) or the inverse (bullish). */
function headAndShoulders(inverse: boolean) {
  return (ctx: ChartContext, t: number): PatternHit | null => {
    const peaks = inverse ? ctx.pivotLows : ctx.pivotHighs;
    const last = lastBefore(peaks, t - T.pivotSpan);
    if (last < 2) return null;
    const left = peaks[last - 2]!, head = peaks[last - 1]!, right = peaks[last]!;
    if (left < t - T.hsWindowDays) return null;
    if (head - left < T.hsMinSpacingDays || right - head < T.hsMinSpacingDays) return null;
    const l = ctx.close[left]!, h = ctx.close[head]!, r = ctx.close[right]!;
    const beyond = (x: number, y: number) => (inverse ? x <= y * (1 - T.hsHeadOverShoulders) : x >= y * (1 + T.hsHeadOverShoulders));
    if (!beyond(h, l) || !beyond(h, r)) return null;
    if (Math.abs(l / r - 1) > T.hsShoulderTolerance) return null;
    // Neckline: the reaction lows (highs) between the shoulders and the head.
    const between = (from: number, to: number) => {
      let value = inverse ? -Infinity : Infinity;
      for (let i = from + 1; i < to; i += 1) value = inverse ? Math.max(value, ctx.close[i]!) : Math.min(value, ctx.close[i]!);
      return value;
    };
    const n1 = between(left, head), n2 = between(head, right);
    const neck = inverse ? Math.max(n1, n2) : Math.min(n1, n2);
    if (!brokeWithin(ctx, t, neck, inverse)) return null;
    const depth = Math.abs(h / neck - 1);
    return {
      strength: clamp01(0.5 + depth / 0.3),
      detail: `${inverse ? "Inverse head and shoulders" : "Head and shoulders"}: ${inverse ? "low" : "peak"} at ${h.toFixed(2)} between shoulders near ${((l + r) / 2).toFixed(2)}, and price ${inverse ? "rose above" : "fell below"} the ${neck.toFixed(2)} neckline.`,
    };
  };
}

function band(lower: boolean) {
  return (ctx: ChartContext, t: number): PatternHit | null => {
    const price = ctx.close[t]!, edge = lower ? ctx.bbLower[t] : ctx.bbUpper[t];
    if (edge == null) return null;
    if (lower ? price >= edge : price <= edge) return null;
    const beyond = Math.abs(price / edge - 1);
    return {
      strength: clamp01(0.5 + beyond / 0.1),
      detail: `Price is ${pct(beyond)} ${lower ? "below the lower" : "above the upper"} Bollinger band (20-day, 2 standard deviations).`,
    };
  };
}

function flow(measure: "sales" | "listings", rising: boolean) {
  return (ctx: ChartContext, t: number): PatternHit | null => {
    const values = ctx[measure];
    const recent = average(values, t - T.demandRecentDays + 1, t);
    const base = average(values, t - T.demandRecentDays - T.demandBaseDays + 1, t - T.demandRecentDays);
    if (recent.mean == null || base.mean == null || base.mean <= 0) return null;
    if (recent.coverage < T.demandMinCoverage || base.coverage < T.demandMinCoverage) return null;
    const ratio = recent.mean / base.mean;
    if (rising ? ratio < T.demandRiseRatio : ratio > T.demandFallRatio) return null;
    const label = measure === "sales" ? "Sales" : "Listings";
    return {
      strength: clamp01(0.4 + Math.abs(ratio - 1)),
      detail: `${label} averaged ${recent.mean.toFixed(1)} a day over the last ${T.demandRecentDays} days, ${ratio.toFixed(2)}x the ${T.demandBaseDays} days before.`,
    };
  };
}

function populationGrowth(ctx: ChartContext, t: number): PatternHit | null {
  const now = ctx.population[t];
  if (now == null) return null;
  let then: number | null = null;
  for (let i = Math.max(0, t - T.populationLookbackDays); i < t; i += 1) {
    if (ctx.population[i] != null) {
      then = ctx.population[i]!;
      break;
    }
  }
  if (then == null || then <= 0) return null;
  const growth = now / then - 1;
  if (growth < T.populationGrowth) return null;
  return { strength: clamp01(0.4 + growth), detail: `Graded population grew ${pct(growth)} (to ${now}) in the last ${T.populationLookbackDays} days.` };
}

const MACD_POINTS = T.macdSlow + T.macdSignal;
const VOLUME_POINTS = T.levelWindowDays + T.breakoutRecentDays + 1;

export const CHART_PATTERNS: readonly ChartPatternDef[] = [
  {
    key: "golden_cross", name: "Golden cross", category: "trend", direction: "bullish", group: "ma_cross",
    horizonDays: 60, minPoints: T.maLong + 1, baseWeight: 1.5, priorHitRate: 0.55,
    rule: "The 50-day moving average crossed above the 200-day moving average within the last 10 days.",
    explanation: "The medium-term average price has moved above the long-term one, which often marks the start of a longer uptrend.",
    detect: maCross(true),
  },
  {
    key: "death_cross", name: "Death cross", category: "trend", direction: "bearish", group: "ma_cross",
    horizonDays: 60, minPoints: T.maLong + 1, baseWeight: 1.5, priorHitRate: 0.55,
    rule: "The 50-day moving average crossed below the 200-day moving average within the last 10 days.",
    explanation: "The medium-term average price has dropped under the long-term one, which often marks the start of a longer downtrend.",
    detect: maCross(false),
  },
  {
    key: "uptrend", name: "Uptrend", category: "trend", direction: "bullish", group: "trend",
    horizonDays: 30, minPoints: T.maMedium + T.trendSlopeDays, baseWeight: 1.2, priorHitRate: 0.55,
    rule: "Price above the 20-day average, the 20-day above the 50-day, and the 50-day higher than 10 days ago.",
    explanation: "Prices are stacked in rising order across short and medium averages: buyers have been paying more over time.",
    detect: trend(true),
  },
  {
    key: "downtrend", name: "Downtrend", category: "trend", direction: "bearish", group: "trend",
    horizonDays: 30, minPoints: T.maMedium + T.trendSlopeDays, baseWeight: 1.2, priorHitRate: 0.55,
    rule: "Price below the 20-day average, the 20-day below the 50-day, and the 50-day lower than 10 days ago.",
    explanation: "Prices are stacked in falling order across short and medium averages: the card has been getting cheaper.",
    detect: trend(false),
  },
  {
    key: "rsi_oversold", name: "RSI oversold", category: "momentum", direction: "bullish", group: "rsi",
    horizonDays: 14, minPoints: 30, baseWeight: 0.8, priorHitRate: 0.52,
    rule: "RSI(14) below 30.",
    explanation: "The price fell fast relative to its recent moves; sharp drops like this often bounce.",
    detect: rsiExtreme(true),
  },
  {
    key: "rsi_overbought", name: "RSI overbought", category: "momentum", direction: "bearish", group: "rsi",
    horizonDays: 14, minPoints: 30, baseWeight: 0.8, priorHitRate: 0.52,
    rule: "RSI(14) above 70.",
    explanation: "The price rose fast relative to its recent moves; spikes like this often cool off.",
    detect: rsiExtreme(false),
  },
  {
    key: "macd_bullish_cross", name: "MACD bullish crossover", category: "momentum", direction: "bullish", group: "macd",
    horizonDays: 21, minPoints: Math.max(30, MACD_POINTS), baseWeight: 0.8, priorHitRate: 0.53,
    rule: "MACD(12,26) crossed above its 9-day signal line within the last 5 days.",
    explanation: "Short-term price momentum has turned up relative to the longer-term trend.",
    detect: macdCross(true),
  },
  {
    key: "macd_bearish_cross", name: "MACD bearish crossover", category: "momentum", direction: "bearish", group: "macd",
    horizonDays: 21, minPoints: Math.max(30, MACD_POINTS), baseWeight: 0.8, priorHitRate: 0.53,
    rule: "MACD(12,26) crossed below its 9-day signal line within the last 5 days.",
    explanation: "Short-term price momentum has turned down relative to the longer-term trend.",
    detect: macdCross(false),
  },
  {
    key: "resistance_breakout", name: "Resistance breakout", category: "levels", direction: "bullish", group: "levels",
    horizonDays: 30, minPoints: VOLUME_POINTS, baseWeight: 1.2, priorHitRate: 0.55,
    rule: "Close at least 2% above the highest close of the prior 30 days (tested at least twice), within the last 3 days; stronger when sales are 1.5x their average.",
    explanation: "The price pushed through a ceiling it had failed to clear before. Breakouts backed by more sales are more reliable.",
    detect: breakout(true),
  },
  {
    key: "support_breakdown", name: "Support breakdown", category: "levels", direction: "bearish", group: "levels",
    horizonDays: 30, minPoints: VOLUME_POINTS, baseWeight: 1.2, priorHitRate: 0.55,
    rule: "Close at least 2% below the lowest close of the prior 30 days (tested at least twice), within the last 3 days; stronger when sales are 1.5x their average.",
    explanation: "The price fell through a floor that had held before, so sellers are accepting less than recent buyers paid.",
    detect: breakout(false),
  },
  {
    key: "double_bottom", name: "Double bottom", category: "reversal", direction: "bullish", group: "double",
    horizonDays: 30, minPoints: 40, baseWeight: 1.0, priorHitRate: 0.55,
    rule: "Two lows within 3% of each other at least 10 days apart in the last 60 days, a rally of 5% or more between them, and a close back above that rally's high within the last 5 days.",
    explanation: "Buyers stepped in twice at the same price and the card has since climbed past the level between them: a common bottoming shape.",
    detect: double(true),
  },
  {
    key: "double_top", name: "Double top", category: "reversal", direction: "bearish", group: "double",
    horizonDays: 30, minPoints: 40, baseWeight: 1.0, priorHitRate: 0.55,
    rule: "Two highs within 3% of each other at least 10 days apart in the last 60 days, a drop of 5% or more between them, and a close below that drop's low within the last 5 days.",
    explanation: "The price failed twice at the same ceiling and has since fallen below the dip between them: a common topping shape.",
    detect: double(false),
  },
  {
    key: "head_and_shoulders", name: "Head and shoulders", category: "reversal", direction: "bearish", group: "head_shoulders",
    horizonDays: 30, minPoints: 60, baseWeight: 1.0, priorHitRate: 0.55,
    rule: "Three peaks in the last 90 days, the middle one at least 3% above two shoulders within 5% of each other, then a close below the neckline within the last 5 days.",
    explanation: "A final push higher failed and the price broke the floor of the whole shape, which often ends an uptrend.",
    detect: headAndShoulders(false),
  },
  {
    key: "inverse_head_and_shoulders", name: "Inverse head and shoulders", category: "reversal", direction: "bullish", group: "head_shoulders",
    horizonDays: 30, minPoints: 60, baseWeight: 1.0, priorHitRate: 0.55,
    rule: "Three lows in the last 90 days, the middle one at least 3% below two shoulders within 5% of each other, then a close above the neckline within the last 5 days.",
    explanation: "A final drop found buyers and the price broke above the ceiling of the whole shape, which often ends a downtrend.",
    detect: headAndShoulders(true),
  },
  {
    key: "bollinger_lower_break", name: "Below lower Bollinger band", category: "volatility", direction: "bullish", group: "bollinger",
    horizonDays: 14, minPoints: 30, baseWeight: 0.6, priorHitRate: 0.52,
    rule: "Close below the 20-day average minus 2 standard deviations.",
    explanation: "The price is unusually low for its recent range; moves this far from the average often snap back.",
    detect: band(true),
  },
  {
    key: "bollinger_upper_break", name: "Above upper Bollinger band", category: "volatility", direction: "bearish", group: "bollinger",
    horizonDays: 14, minPoints: 30, baseWeight: 0.6, priorHitRate: 0.52,
    rule: "Close above the 20-day average plus 2 standard deviations.",
    explanation: "The price is unusually high for its recent range; moves this far from the average often pull back.",
    detect: band(false),
  },
  {
    key: "demand_rising", name: "Rising demand", category: "demand", direction: "bullish", group: "demand", requires: "sales",
    horizonDays: 30, minPoints: T.demandRecentDays + T.demandBaseDays, baseWeight: 1.0, priorHitRate: 0.55,
    rule: "Average daily sales over the last 14 days at least 1.25x the 30 days before.",
    explanation: "More copies are selling than before: buyers are absorbing supply.",
    detect: flow("sales", true),
  },
  {
    key: "demand_falling", name: "Falling demand", category: "demand", direction: "bearish", group: "demand", requires: "sales",
    horizonDays: 30, minPoints: T.demandRecentDays + T.demandBaseDays, baseWeight: 1.0, priorHitRate: 0.55,
    rule: "Average daily sales over the last 14 days at most 0.75x the 30 days before.",
    explanation: "Fewer copies are selling than before: buyers are stepping back.",
    detect: flow("sales", false),
  },
  {
    key: "supply_rising", name: "Rising supply", category: "demand", direction: "bearish", group: "supply", requires: "listings",
    horizonDays: 30, minPoints: T.demandRecentDays + T.demandBaseDays, baseWeight: 0.8, priorHitRate: 0.55,
    rule: "Average active listings over the last 14 days at least 1.25x the 30 days before.",
    explanation: "More copies are listed for sale than before, which tends to push prices down.",
    detect: flow("listings", true),
  },
  {
    key: "supply_falling", name: "Shrinking supply", category: "demand", direction: "bullish", group: "supply", requires: "listings",
    horizonDays: 30, minPoints: T.demandRecentDays + T.demandBaseDays, baseWeight: 0.8, priorHitRate: 0.55,
    rule: "Average active listings over the last 14 days at most 0.75x the 30 days before.",
    explanation: "Fewer copies are listed for sale than before, which tends to support prices.",
    detect: flow("listings", false),
  },
  {
    key: "population_growth", name: "Population growth", category: "population", direction: "bearish", group: "population", requires: "population",
    horizonDays: 60, minPoints: 30, baseWeight: 0.6, priorHitRate: 0.52,
    rule: "Graded population up 10% or more over the last 90 days.",
    explanation: "Many more copies have been graded at this grade recently, so the grade is becoming less scarce.",
    detect: populationGrowth,
  },
];

export const CHART_PATTERN_BY_KEY: ReadonlyMap<string, ChartPatternDef> = new Map(CHART_PATTERNS.map((p) => [p.key, p]));
