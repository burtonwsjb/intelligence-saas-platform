import { describe, expect, it } from "vitest";
import { macd, pivots, rsi, sma } from "./indicators.js";
import { buildChartContext, CHART_PATTERN_BY_KEY, CHART_PATTERNS } from "./patterns.js";
import { backtestChartSeries, blendedHitRate, reliability, scoreChartSeries, sumBacktests } from "./score.js";
import { buildChartSeries, MAX_GAP_DAYS, segmentKey, type ChartInputRow, type ChartSeries, type DailyPoint } from "./series.js";

const START = Date.parse("2026-01-01T00:00:00.000Z");
const day = (i: number) => new Date(START + i * 86_400_000).toISOString().slice(0, 10);

/** Piecewise-linear prices through [day, price] knots. */
function path(knots: Array<[number, number]>): number[] {
  const out: number[] = [];
  for (let k = 0; k < knots.length - 1; k += 1) {
    const [d0, p0] = knots[k]!;
    const [d1, p1] = knots[k + 1]!;
    for (let d = d0; d < d1; d += 1) out.push(p0 + ((p1 - p0) * (d - d0)) / (d1 - d0));
  }
  out.push(knots[knots.length - 1]![1]);
  return out;
}

function points(prices: number[], extra: Partial<Record<"sales" | "listings" | "population", (number | null)[]>> = {}): DailyPoint[] {
  return prices.map((price, i) => ({
    day: day(i),
    price,
    sales: extra.sales?.[i] ?? null,
    listings: extra.listings?.[i] ?? null,
    population: extra.population?.[i] ?? null,
    filled: false,
  }));
}

function series(prices: number[], extra: Parameters<typeof points>[1] = {}): ChartSeries {
  return { segment: "raw", gradingCompany: null, grade: null, currency: "USD", priceType: "reference", points: points(prices, extra), otherCurrencyRows: 0 };
}

/** Detects one pattern on the last day of the prices. */
function fires(key: string, prices: number[], extra: Parameters<typeof points>[1] = {}) {
  const pattern = CHART_PATTERN_BY_KEY.get(key)!;
  const ctx = buildChartContext(points(prices, extra));
  return pattern.detect(ctx, prices.length - 1);
}

const mirror = (prices: number[]) => prices.map((p) => 300 - p);

describe("chart indicators", () => {
  it("computes causal moving averages, RSI and MACD", () => {
    expect(sma([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5]);
    const rising = Array.from({ length: 40 }, (_, i) => 100 + i);
    expect(rsi(rising)[39]).toBe(100);
    expect(rsi(Array.from({ length: 40 }, () => 50))[39]).toBe(50);
    const m = macd(rising);
    expect(m.line[24]).toBe(null);
    expect((m.line[39] ?? 0) > 0).toBe(true);
    // Values up to i never change when later data is appended.
    const longer = [...rising, 10, 10, 10];
    expect(rsi(longer).slice(0, 40)).toEqual(rsi(rising));
  });

  it("marks the first day of a flat top as one pivot", () => {
    const { highs, lows } = pivots([1, 2, 3, 5, 5, 4, 3, 2, 3, 4, 5], 3);
    expect(highs).toEqual([3]);
    expect(lows).toEqual([7]);
  });
});

describe("chart patterns: should and should not trigger", () => {
  it("golden cross fires within 10 days of the 50-day crossing the 200-day, and death cross on the mirror", () => {
    const prices = path([[0, 120], [180, 80], [300, 140]]);
    const ma50 = sma(prices, 50), ma200 = sma(prices, 200);
    let cross = -1;
    for (let i = 200; i < prices.length; i += 1) {
      if (ma50[i - 1]! <= ma200[i - 1]! && ma50[i]! > ma200[i]!) { cross = i; break; }
    }
    expect(cross > 0).toBe(true);
    expect(fires("golden_cross", prices.slice(0, cross + 3)) != null).toBe(true);
    expect(fires("golden_cross", prices.slice(0, cross))).toBe(null);
    expect(fires("golden_cross", prices.slice(0, cross + 20))).toBe(null);
    expect(fires("death_cross", prices.slice(0, cross + 3))).toBe(null);
    expect(fires("death_cross", mirror(prices).slice(0, cross + 3)) != null).toBe(true);
  });

  it("uptrend fires on a steady rise, downtrend on a steady fall, neither on a flat line", () => {
    const up = Array.from({ length: 80 }, (_, i) => 100 * 1.005 ** i);
    expect(fires("uptrend", up) != null).toBe(true);
    expect(fires("downtrend", up)).toBe(null);
    const down = Array.from({ length: 80 }, (_, i) => 100 * 0.995 ** i);
    expect(fires("downtrend", down) != null).toBe(true);
    const flat = Array.from({ length: 80 }, () => 100);
    expect(fires("uptrend", flat)).toBe(null);
    expect(fires("downtrend", flat)).toBe(null);
  });

  it("RSI oversold after a run of drops, overbought after a run of gains", () => {
    const wobble = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 ? 1 : -1));
    const drop = [...wobble, ...Array.from({ length: 10 }, (_, i) => 98 - 3 * (i + 1))];
    expect(fires("rsi_oversold", drop) != null).toBe(true);
    expect(fires("rsi_overbought", drop)).toBe(null);
    const rise = [...wobble, ...Array.from({ length: 10 }, (_, i) => 102 + 3 * (i + 1))];
    expect(fires("rsi_overbought", rise) != null).toBe(true);
    expect(fires("rsi_oversold", wobble)).toBe(null);
  });

  it("MACD bullish crossover fires shortly after a decline turns up, not during the decline", () => {
    const prices = path([[0, 150], [50, 100], [70, 120]]);
    expect(fires("macd_bullish_cross", prices.slice(0, 45))).toBe(null);
    const firstDay = Array.from({ length: 20 }, (_, i) => 50 + i).find((n) => fires("macd_bullish_cross", prices.slice(0, n)) != null);
    expect(firstDay != null && firstDay <= 60).toBe(true);
    expect(fires("macd_bearish_cross", mirror(prices).slice(0, firstDay!)) != null).toBe(true);
  });

  it("resistance breakout needs a tested level and a fresh close through it; volume confirms it", () => {
    const range = Array.from({ length: 40 }, (_, i) => 97.5 + 2.5 * Math.sin(i / 2));
    const breakout = [...range, 101, 103, 105];
    const hit = fires("resistance_breakout", breakout);
    expect(hit != null).toBe(true);
    expect(hit!.detail).toContain("No sales volume");
    const sales = [...Array.from({ length: 38 }, () => 2), 2, 2, 6, 8, 9];
    const confirmed = fires("resistance_breakout", breakout, { sales });
    expect(confirmed!.detail).toContain("Confirmed by volume");
    expect(confirmed!.strength > hit!.strength).toBe(true);
    expect(fires("resistance_breakout", range)).toBe(null);
    // Long after the break the move is no longer fresh.
    expect(fires("resistance_breakout", [...breakout, 106, 107, 108, 109])).toBe(null);
    const breakdown = [...range, 94, 92, 90];
    expect(fires("support_breakdown", breakdown) != null).toBe(true);
    expect(fires("resistance_breakout", breakdown)).toBe(null);
  });

  it("double bottom fires on the neckline break, not before it and not when the lows differ", () => {
    const shape = path([[0, 130], [20, 100], [30, 110], [40, 100.5], [46, 113]]);
    expect(fires("double_bottom", shape) != null).toBe(true);
    expect(fires("double_bottom", shape.slice(0, 44))).toBe(null);
    const uneven = path([[0, 130], [20, 100], [30, 110], [40, 90], [46, 113]]);
    expect(fires("double_bottom", uneven)).toBe(null);
    expect(fires("double_top", mirror(shape)) != null).toBe(true);
    expect(fires("double_top", shape)).toBe(null);
  });

  it("head and shoulders fires on a neckline break after three peaks, and the inverse on the mirror", () => {
    const shape = path([[0, 75], [20, 100], [28, 92], [40, 110], [50, 93], [60, 101], [67, 89.6]]);
    expect(fires("head_and_shoulders", shape) != null).toBe(true);
    expect(fires("head_and_shoulders", shape.slice(0, 64))).toBe(null);
    const noHead = path([[0, 75], [20, 100], [28, 92], [40, 101], [50, 93], [60, 100], [67, 89.6]]);
    expect(fires("head_and_shoulders", noHead)).toBe(null);
    expect(fires("inverse_head_and_shoulders", mirror(shape)) != null).toBe(true);
    expect(fires("inverse_head_and_shoulders", shape)).toBe(null);
  });

  it("Bollinger band breaks fire beyond 2 standard deviations only", () => {
    const calm = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 ? 1 : -1));
    expect(fires("bollinger_lower_break", [...calm, 90]) != null).toBe(true);
    expect(fires("bollinger_upper_break", [...calm, 110]) != null).toBe(true);
    expect(fires("bollinger_lower_break", [...calm, 99])).toBe(null);
  });

  it("demand and supply compare the last 14 days with the 30 before; population growth needs a population", () => {
    const flat = Array.from({ length: 50 }, () => 100);
    const sales = [...Array.from({ length: 36 }, () => 1), ...Array.from({ length: 14 }, () => 3)];
    expect(fires("demand_rising", flat, { sales }) != null).toBe(true);
    expect(fires("demand_falling", flat, { sales })).toBe(null);
    expect(fires("demand_rising", flat)).toBe(null);
    const listings = [...Array.from({ length: 36 }, () => 40), ...Array.from({ length: 14 }, () => 20)];
    expect(fires("supply_falling", flat, { listings }) != null).toBe(true);
    const population = flat.map((_, i) => (i === 0 ? 1000 : i === 49 ? 1200 : null));
    expect(fires("population_growth", flat, { population }) != null).toBe(true);
    expect(fires("population_growth", flat, { population: flat.map((_, i) => (i === 0 ? 1000 : i === 49 ? 1050 : null)) })).toBe(null);
  });

  it("every catalog entry has a unique key, a rule, an explanation and a sane prior", () => {
    expect(new Set(CHART_PATTERNS.map((p) => p.key)).size).toBe(CHART_PATTERNS.length);
    for (const p of CHART_PATTERNS) {
      expect(p.rule.length > 10 && p.explanation.length > 10).toBe(true);
      expect(p.priorHitRate > 0.5 && p.priorHitRate < 0.7).toBe(true);
    }
  });
});

describe("chart sentiment score", () => {
  const now = new Date(START + 82 * 86_400_000);

  it("reports insufficient history below 30 points", () => {
    const result = scoreChartSeries(series(Array.from({ length: 20 }, () => 10)), new Map(), now);
    expect(result.label).toBe("insufficient_history");
    expect(result.score).toBe(null);
    expect(result.insufficient.length).toBe(CHART_PATTERNS.length);
  });

  it("scores a steady rise bullish and a steady fall bearish, with the signals that drove it", () => {
    const up = scoreChartSeries(series(Array.from({ length: 80 }, (_, i) => 100 * 1.005 ** i)), new Map(), now);
    expect(up.label).toBe("bullish");
    expect(up.score! > 0).toBe(true);
    expect(up.signals.map((s) => s.key)).toContain("uptrend");
    expect(up.insufficient.map((s) => s.key)).toContain("golden_cross");
    expect(up.insufficient.find((s) => s.key === "demand_rising")!.reason).toBe("needs_sales");
    expect(up.confidence > 0 && up.confidence <= 1).toBe(true);
    const down = scoreChartSeries(series(Array.from({ length: 80 }, (_, i) => 100 * 0.995 ** i)), new Map(), now);
    expect(down.label).toBe("bearish");
    expect(down.score! < 0).toBe(true);
    const flat = scoreChartSeries(series(Array.from({ length: 80 }, () => 100)), new Map(), now);
    expect(flat.label).toBe("neutral");
    expect(flat.score).toBe(0);
  });

  it("weights patterns by measured hit rate: a pattern measured no better than a coin flip drops out", () => {
    const prices = Array.from({ length: 80 }, (_, i) => 100 * 1.005 ** i);
    const coinFlip = new Map([["uptrend", { samples: 10_000, hits: 4_900 }]]);
    const result = scoreChartSeries(series(prices), coinFlip, now);
    expect(result.signals.find((s) => s.key === "uptrend")!.contribution).toBe(0);
    expect(blendedHitRate({ priorHitRate: 0.55 }, undefined)).toBe(0.55);
    expect(blendedHitRate({ priorHitRate: 0.55 }, { samples: 70, hits: 56 })).toBe((56 + 30 * 0.55) / 100);
    expect(reliability(0.45)).toBe(0);
    expect(reliability(0.75)).toBe(0.5);
  });

  it("loses confidence as data goes stale", () => {
    const prices = Array.from({ length: 80 }, (_, i) => 100 * 1.005 ** i);
    const fresh = scoreChartSeries(series(prices), new Map(), now);
    const stale = scoreChartSeries(series(prices), new Map(), new Date(now.getTime() + 40 * 86_400_000));
    expect(stale.confidence).toBe(0);
    expect(fresh.confidence > 0).toBe(true);
  });

  it("backtests without look-ahead and does not count overlapping samples", () => {
    const up = Array.from({ length: 200 }, (_, i) => 100 * 1.005 ** i);
    const result = backtestChartSeries({ points: points(up) });
    // An uptrend first readable at day 59, judged 30 days later, then every 30 days (59, 89, 119, 149).
    expect(result.uptrend).toEqual({ samples: 4, hits: 4, flat: 0 });
    expect(result.downtrend).toBe(undefined);
    expect(backtestChartSeries({ points: points(Array.from({ length: 200 }, () => 100)) })).toEqual({});
    const total = sumBacktests([result, { uptrend: { samples: 2, hits: 0, flat: 1 } }]);
    expect(total.get("uptrend")).toEqual({ samples: 6, hits: 4, flat: 1 });
  });
});

describe("chart series", () => {
  const at = (i: number, hour = 12) => new Date(START + i * 86_400_000 + hour * 3_600_000);
  const row = (i: number, price: number, extra: Partial<ChartInputRow> = {}): ChartInputRow => ({
    observedAt: at(i),
    priceType: "reference",
    currency: "USD",
    gradingCompany: null,
    gradeLabel: null,
    gradeNumeric: null,
    price,
    salesCount: null,
    listingCount: null,
    population: null,
    ...extra,
  });

  it("keeps raw and each grade separate, one price type and one currency each", () => {
    const rows: ChartInputRow[] = [
      row(0, 10), row(1, 11), row(1, 13, { observedAt: at(1, 18) }),
      row(2, 12), row(2, 999, { currency: "JPY" }),
      row(0, 100, { gradingCompany: "PSA", gradeNumeric: "10.00", priceType: "sold", salesCount: 2 }),
      row(1, 105, { gradingCompany: "PSA", gradeNumeric: "10.00", priceType: "sold", salesCount: 1 }),
      row(1, 50, { gradingCompany: "PSA", gradeNumeric: "9", priceType: "sold" }),
    ];
    const built = buildChartSeries(rows);
    expect(built.map((s) => s.segment)).toEqual(["raw", "psa10", "psa9"]);
    expect(built[0]!.points.map((p) => p.price)).toEqual([10, 12, 12]);
    expect(built[0]!.otherCurrencyRows).toBe(1);
    expect(built[1]).toMatchObject({ gradingCompany: "PSA", grade: "10", priceType: "sold" });
    expect(built[1]!.points.map((p) => p.sales)).toEqual([2, 1]);
    expect(segmentKey({ gradingCompany: "BGS", gradeLabel: "9.5", gradeNumeric: null })).toBe("bgs9_5");
  });

  it("carries prices over short gaps and starts after a long one", () => {
    const rows = [row(0, 5), row(1, 5), row(20, 10), row(23, 11), row(23 + MAX_GAP_DAYS, 12)];
    const [raw] = buildChartSeries(rows);
    expect(raw!.points[0]!.day).toBe(day(20));
    expect(raw!.points.length).toBe(23 + MAX_GAP_DAYS - 20 + 1);
    expect(raw!.points[1]).toMatchObject({ price: 10, filled: true });
  });

  it("uses the price type with the most days of history", () => {
    const rows = [row(0, 10, { priceType: "sold" }), row(1, 11, { priceType: "sold" }), row(1, 50)];
    expect(buildChartSeries(rows)[0]!.priceType).toBe("sold");
  });
});
