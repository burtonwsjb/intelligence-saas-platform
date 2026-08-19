import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { printingBenchmarkContext, resolveBenchmark } from "./benchmark.js";
import { getIndexLevelAsOf, indexReturn } from "./index-engine.js";
import type { Database } from "../client.js";
import { tcgMarketFeatureSnapshot } from "../schema/analytics.js";
import { tcgMarketSnapshot } from "../schema/tcg-market.js";
import { tcgCardConcept, tcgPrinting } from "../schema/tcg.js";
import { rollingMedian } from "../tcg/market-identity.js";
import {
  DEFAULT_OUTLIER_POLICY,
  MARKET_FEATURE_SET_KEY,
  MARKET_FEATURE_SET_VERSION,
  MARKET_RETURN_DAYS,
  MARKET_RETURN_PERIODS,
  MS_DAY,
  type MarketOutlierPolicy,
  type MarketReturnPeriod,
} from "./catalog.js";

export type ScalarMetric = {
  status: "ok" | "insufficient_data";
  value: number | null;
  sample_size: number;
  method: string;
  window_days?: number;
  interpretation: string;
};

export type ComputeFeaturesInput = {
  printingId: string;
  asOf: Date;
  condition?: string;
  gradingCompany?: string | null;
  gradeLabel?: string | null;
  outlierPolicy?: MarketOutlierPolicy;
  benchmarkReturn30d?: number | null;
};

type SoldPoint = {
  id: string;
  observedAt: Date;
  price: number;
  quantity: number | null;
  sourceKey: string;
  outlierFlag: boolean;
  currency: string;
};

type ListingPoint = {
  observedAt: Date;
  listingCount: number | null;
  sellerCount: number | null;
  lowPrice: number | null;
  medianPrice: number | null;
  sourceKey: string;
};

function metric(
  input: Omit<ScalarMetric, "status"> & { status?: ScalarMetric["status"] },
): ScalarMetric {
  const insufficient = input.value == null || input.status === "insufficient_data";
  return {
    status: insufficient ? "insufficient_data" : "ok",
    value: insufficient ? null : input.value,
    sample_size: input.sample_size,
    method: input.method,
    window_days: input.window_days,
    interpretation: input.interpretation,
  };
}

function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ema(values: number[]): number | null {
  if (values.length < 3) {
    return null;
  }
  const alpha = 2 / (values.length + 1);
  return values.reduce((prev, value) => alpha * value + (1 - alpha) * prev);
}

function mad(values: number[]): number | null {
  if (values.length < 3) {
    return null;
  }
  const med = rollingMedian(values);
  if (med == null) {
    return null;
  }
  const deviations = values.map((value) => Math.abs(value - med));
  return rollingMedian(deviations);
}

function applyOutliers(points: SoldPoint[], policy: MarketOutlierPolicy): SoldPoint[] {
  if (policy === "include_all.v1") {
    return points;
  }
  return points.filter((point) => !point.outlierFlag);
}

function periodSlack(days: number): number {
  return Math.max(MS_DAY, 0.25 * days * MS_DAY);
}

function priceReturn(
  sold: SoldPoint[],
  asOf: Date,
  period: MarketReturnPeriod,
): ScalarMetric {
  const days = MARKET_RETURN_DAYS[period];
  const span = days * MS_DAY;
  const slack = periodSlack(days);
  const startAt = new Date(asOf.getTime() - span);
  const endCandidates = sold.filter(
    (point) => point.observedAt.getTime() <= asOf.getTime() && point.observedAt.getTime() >= asOf.getTime() - slack,
  );
  const startCandidates = sold.filter(
    (point) =>
      point.observedAt.getTime() <= startAt.getTime() && point.observedAt.getTime() >= startAt.getTime() - slack,
  );
  const end = endCandidates.at(-1);
  const start = startCandidates.at(-1);
  if (!end || !start || start.id === end.id || start.price <= 0) {
    return metric({
      value: null,
      sample_size: sold.length,
      method: "nearest_observation.v1",
      window_days: days,
      interpretation:
        "Nearest sold prints inside a collectible slack window. Missing or identical observations are insufficient_data; prices are never interpolated.",
    });
  }
  return metric({
    value: end.price / start.price - 1,
    sample_size: 2,
    method: "nearest_observation.v1",
    window_days: days,
    interpretation:
      "Period return using the latest sold at or before as_of and the latest sold at or before as_of-period, each inside slack=max(1d, 0.25*period). Irregular prints do not invent daily closes.",
  });
}

function salesInWindow(sold: SoldPoint[], asOf: Date, days: number): SoldPoint[] {
  const from = asOf.getTime() - days * MS_DAY;
  return sold.filter((point) => point.observedAt.getTime() > from && point.observedAt.getTime() <= asOf.getTime());
}

function intersaleMedian(points: SoldPoint[]): number | null {
  if (points.length < 2) {
    return null;
  }
  const gaps = points.slice(1).map((point, index) => point.observedAt.getTime() - points[index]!.observedAt.getTime());
  return rollingMedian(gaps);
}

function tradeReturns(points: SoldPoint[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1]!.price;
    const current = points[i]!.price;
    if (prev > 0) {
      returns.push(current / prev - 1);
    }
  }
  return returns;
}

export async function loadPrintingLanguage(db: Database, printingId: string) {
  const [row] = await db
    .select({
      languageCode: tcgPrinting.languageCode,
      gameKey: tcgPrinting.gameKey,
      conceptKey: tcgCardConcept.conceptKey,
    })
    .from(tcgPrinting)
    .innerJoin(tcgCardConcept, eq(tcgCardConcept.id, tcgPrinting.cardId))
    .where(eq(tcgPrinting.id, printingId))
    .limit(1);
  return row ?? null;
}

async function loadSold(
  db: Database,
  input: ComputeFeaturesInput,
): Promise<SoldPoint[]> {
  const condition = input.condition ?? "nm";
  const clauses = [
    eq(tcgMarketSnapshot.printingId, input.printingId),
    eq(tcgMarketSnapshot.priceType, "sold"),
    eq(tcgMarketSnapshot.condition, condition),
    lte(tcgMarketSnapshot.observedAt, input.asOf),
  ];
  if (input.gradingCompany === null || input.gradingCompany === undefined) {
    clauses.push(isNull(tcgMarketSnapshot.gradingCompany));
  } else {
    clauses.push(eq(tcgMarketSnapshot.gradingCompany, input.gradingCompany));
  }
  const rows = await db
    .select()
    .from(tcgMarketSnapshot)
    .where(and(...clauses))
    .orderBy(asc(tcgMarketSnapshot.observedAt));
  return rows
    .filter((row) => row.price != null)
    .filter((row) => (input.gradeLabel ? row.gradeLabel === input.gradeLabel : true))
    .map((row) => ({
      id: row.id,
      observedAt: row.observedAt,
      price: Number(row.price),
      quantity: row.quantity,
      sourceKey: row.sourceKey,
      outlierFlag: row.outlierFlag,
      currency: row.currency,
    }));
}

async function loadListings(db: Database, printingId: string, asOf: Date, condition: string): Promise<ListingPoint[]> {
  const rows = await db
    .select()
    .from(tcgMarketSnapshot)
    .where(
      and(
        eq(tcgMarketSnapshot.printingId, printingId),
        eq(tcgMarketSnapshot.marketType, "marketplace_listing"),
        eq(tcgMarketSnapshot.condition, condition),
        lte(tcgMarketSnapshot.observedAt, asOf),
      ),
    )
    .orderBy(asc(tcgMarketSnapshot.observedAt));
  return rows.map((row) => ({
    observedAt: row.observedAt,
    listingCount: row.listingCount,
    sellerCount: row.sellerCount,
    lowPrice: row.lowPrice == null ? null : Number(row.lowPrice),
    medianPrice: row.medianPrice == null ? null : Number(row.medianPrice),
    sourceKey: row.sourceKey,
  }));
}

export function computeFeaturesFromSeries(input: {
  asOf: Date;
  sold: SoldPoint[];
  listings: ListingPoint[];
  outlierPolicy: MarketOutlierPolicy;
  benchmarkReturn30d?: number | null;
}): Record<string, unknown> {
  const usable = applyOutliers(input.sold, input.outlierPolicy);
  const included = usable.filter((point) => point.observedAt.getTime() <= input.asOf.getTime());
  const listings = input.listings.filter((point) => point.observedAt.getTime() <= input.asOf.getTime());
  const latest = included.at(-1) ?? null;
  const returns = Object.fromEntries(
    MARKET_RETURN_PERIODS.map((period) => [period, priceReturn(included, input.asOf, period)]),
  ) as Record<MarketReturnPeriod, ScalarMetric>;

  const window30 = salesInWindow(included, input.asOf, 30);
  const window7 = salesInWindow(included, input.asOf, 7);
  const window1 = salesInWindow(included, input.asOf, 1);
  const prior7 = included.filter((point) => {
    const t = point.observedAt.getTime();
    return t > input.asOf.getTime() - 14 * MS_DAY && t <= input.asOf.getTime() - 7 * MS_DAY;
  });

  const rolling = metric({
    value: rollingMedian(window30.map((point) => point.price)),
    sample_size: window30.length,
    method: "rolling_median.v1",
    window_days: 30,
    interpretation:
      "Median of completed-sale prices in the trailing 30d as of the calculation time. Listing asks are not sales.",
  });
  const sma = metric({
    value: window30.length >= 3 ? mean(window30.map((point) => point.price)) : null,
    sample_size: window30.length,
    method: "sma_trade_time.v1",
    window_days: 30,
    interpretation:
      "Simple mean of actual sold prints in the window. Empty calendar days are omitted; they are not treated as zero-return sessions.",
  });
  const emaValue = metric({
    value: ema(window30.map((point) => point.price)),
    sample_size: window30.length,
    method: "ema_trade_time.v1",
    window_days: 30,
    interpretation:
      "EMA over the ordered sold-price sequence, not over calendar days. Calendar EMA would overweight days with no print.",
  });

  const salesPerDay = metric({
    value: window30.length / 30,
    sample_size: window30.length,
    method: "sales_count.v1",
    window_days: 30,
    interpretation: "Completed-sale count / 30. Listing count is never used as volume.",
  });
  const medianGap = metric({
    value: intersaleMedian(window30),
    sample_size: Math.max(0, window30.length - 1),
    method: "median_intersale.v1",
    window_days: 30,
    interpretation: "Median milliseconds between consecutive completed sales in the window.",
  });

  const volumeMomentum = metric({
    value: window7.length >= 2 && prior7.length >= 2 ? window7.length / prior7.length - 1 : null,
    sample_size: window7.length + prior7.length,
    method: "volume_momentum.v1",
    window_days: 7,
    interpretation:
      "(sales_7d / sales_prior_7d) - 1. Requires at least two completed sales in each window. Does not use listing counts.",
  });

  const latestListing = listings.at(-1) ?? null;
  const priorListing = listings.length >= 2 ? listings[listings.length - 2]! : null;
  const listingCount = latestListing?.listingCount ?? null;
  const listingChange =
    listingCount != null && priorListing?.listingCount != null ? listingCount - priorListing.listingCount : null;
  const sellerCount = latestListing?.sellerCount ?? null;
  const sellerChange =
    sellerCount != null && priorListing?.sellerCount != null ? sellerCount - priorListing.sellerCount : null;
  const listingSaleRatio = metric({
    value: listingCount != null && window7.length > 0 ? listingCount / window7.length : null,
    sample_size: window7.length,
    method: "listing_sale_ratio.v1",
    window_days: 7,
    interpretation: "Active listings / completed sales in 7d. High ratio is more supply than demand confirmation.",
  });
  const absorption = metric({
    value: listingCount != null && listingCount > 0 ? window7.length / listingCount : null,
    sample_size: window7.length,
    method: "absorption.v1",
    window_days: 7,
    interpretation: "Completed sales in 7d / active listings. Higher means inventory is being absorbed.",
  });

  const spreadNow =
    latestListing?.lowPrice != null && latest?.price ? latestListing.lowPrice - latest.price : null;
  const spreadPrev =
    priorListing?.lowPrice != null && included.at(-2)?.price
      ? priorListing.lowPrice - included.at(-2)!.price
      : null;
  const spreadChange = metric({
    value: spreadNow != null && spreadPrev != null ? spreadNow - spreadPrev : null,
    sample_size: spreadNow != null && spreadPrev != null ? 2 : 0,
    method: "spread_change.v1",
    interpretation: "Change in (lowest ask − latest sold). Listings and sales stay separate.",
  });

  const tradeRet = tradeReturns(window30.length >= 3 ? window30 : included.slice(-12));
  const volatility = metric({
    value: mad(tradeRet),
    sample_size: tradeRet.length,
    method: "mad_trade_returns.v1",
    window_days: 30,
    interpretation:
      "Median absolute deviation of consecutive sold-to-sold returns. Days without a print are not imputed.",
  });

  const peak = included.reduce((max, point) => (point.price > max ? point.price : max), 0);
  const drawdown = metric({
    value: peak > 0 && latest ? (peak - latest.price) / peak : null,
    sample_size: included.length,
    method: "peak_to_current.v1",
    interpretation:
      "Peak-to-current on the observed sold series as of calculation time. No interpolated intra-gap prices.",
  });

  const momentum = returns["30d"].status === "ok" ? returns["30d"] : returns["7d"];
  const rs = metric({
    value:
      momentum.status === "ok" && input.benchmarkReturn30d != null
        ? momentum.value! - input.benchmarkReturn30d
        : null,
    sample_size: momentum.sample_size,
    method: "relative_strength.v1",
    window_days: momentum.window_days,
    interpretation:
      "Printing return minus the selected language-aware benchmark return. Absolute return is stored separately and is never mixed across languages.",
  });

  const lastReturn = tradeRet.at(-1) ?? null;
  const thinVolumeSpike = Boolean(lastReturn != null && Math.abs(lastReturn) > 0.25 && window7.length <= 1);
  const priceJumpNoVolume = Boolean(lastReturn != null && lastReturn > 0.2 && window7.length <= 1);
  const supplyDisappearance = Boolean(
    listingChange != null && listingChange < 0 && Math.abs(listingChange) >= 0.5 * (priorListing?.listingCount ?? 0) && window7.length === 0,
  );
    const outlierDriven = Boolean(input.sold.filter((point) => point.observedAt.getTime() <= input.asOf.getTime()).at(-1)?.outlierFlag);
  const pvDivergence = Boolean(
    returns["7d"].status === "ok" &&
      returns["7d"].value != null &&
      volumeMomentum.status === "ok" &&
      volumeMomentum.value != null &&
      returns["7d"].value > 0.05 &&
      volumeMomentum.value < -0.2,
  );

  const breakout = Boolean(
    returns["7d"].status === "ok" &&
      (returns["7d"].value ?? 0) > 0.1 &&
      window7.length >= 3 &&
      !thinVolumeSpike &&
      !priceJumpNoVolume,
  );
  const reversal = Boolean(
    drawdown.status === "ok" && (drawdown.value ?? 0) > 0.2 && (returns["7d"].value ?? 0) > 0 && window7.length >= 2,
  );
  const anomaly = Boolean(latest?.outlierFlag || outlierDriven);

  const sourceCounts: Record<string, number> = {};
  for (const point of included) {
    sourceCounts[point.sourceKey] = (sourceCounts[point.sourceKey] ?? 0) + 1;
  }
  const expectedPeriods = MARKET_RETURN_PERIODS.length;
  const okPeriods = MARKET_RETURN_PERIODS.filter((period) => returns[period].status === "ok").length;
  const stalenessHours = latest ? (input.asOf.getTime() - latest.observedAt.getTime()) / 3_600_000 : null;
  let quality: string = "insufficient_data";
  if (included.length >= 8 && okPeriods >= 3) {
    quality = "complete";
  } else if (included.length >= 2) {
    quality = "partial";
  }
  if (stalenessHours != null && stalenessHours > 24 * 30 && included.length > 0) {
    quality = "stale";
  }
  if (outlierDriven && included.length < 5) {
    quality = "outlier_dependent";
  }

  return {
    feature_set_key: MARKET_FEATURE_SET_KEY,
    feature_set_version: MARKET_FEATURE_SET_VERSION,
    as_of: input.asOf.toISOString(),
    outlier_policy: input.outlierPolicy,
    returns,
    rolling_median: rolling,
    moving_average: sma,
    exponential_moving_average: emaValue,
    sales_velocity: {
      sales_1d: window1.length,
      sales_7d: window7.length,
      sales_30d: window30.length,
      sales_per_day_30d: salesPerDay,
      median_intersale_ms: medianGap,
      interpretation: "Transaction frequency from completed sales only.",
    },
    volume_momentum: volumeMomentum,
    supply: {
      listing_count: listingCount,
      listing_change: listingChange,
      seller_count: sellerCount,
      seller_change: sellerChange,
      listing_sale_ratio: listingSaleRatio,
      absorption_ratio: absorption,
      interpretation:
        "Listing snapshots measure offer-side pressure. Sales measure demand confirmation. They are never substituted for each other.",
    },
    spread_change: spreadChange,
    volatility,
    drawdown,
    momentum: {
      ...momentum,
      interpretation: "Transparent period return used as a momentum component. Not a buy/sell recommendation.",
    },
    absolute_return_30d: returns["30d"],
    relative_strength: rs,
    price_volume_divergence: {
      flag: pvDivergence,
      method: "price_up_volume_down.v1",
      interpretation: "Price up while completed-sale activity down is a caution flag, not a buy.",
    },
    candidates: {
      breakout: breakout,
      reversal,
      anomaly,
      interpretation: "Candidates only. Liquidity and sample gates apply; no recommendation is issued.",
    },
    manipulation_foundation: {
      thin_volume_spike: thinVolumeSpike,
      price_jump_without_volume: priceJumpNoVolume,
      supply_disappearance: supplyDisappearance,
      outlier_driven: outlierDriven,
      interpretation: "Foundation flags only. No final manipulation risk score in Phase 13.",
    },
    data_quality: {
      state: quality,
      sample_size: included.length,
      sample_size_raw: input.sold.length,
      coverage: okPeriods / expectedPeriods,
      staleness_hours: stalenessHours,
      outlier_policy: input.outlierPolicy,
      source_composition: sourceCounts,
    },
    latest_sold_price: latest?.price ?? null,
    latest_sold_at: latest?.observedAt.toISOString() ?? null,
  };
}

export async function computeMarketFeatures(db: Database, input: ComputeFeaturesInput) {
  const identity = await loadPrintingLanguage(db, input.printingId);
  if (!identity) {
    throw new Error("printing not found.");
  }
  const outlierPolicy = input.outlierPolicy ?? DEFAULT_OUTLIER_POLICY;
  const sold = await loadSold(db, input);
  const listings = await loadListings(db, input.printingId, input.asOf, input.condition ?? "nm");
  const features = computeFeaturesFromSeries({
    asOf: input.asOf,
    sold,
    listings,
    outlierPolicy,
    benchmarkReturn30d: input.benchmarkReturn30d,
  });
  const quality = features.data_quality as { state: string; sample_size: number; coverage: number; staleness_hours: number | null; source_composition: Record<string, number> };
  return {
    printingId: input.printingId,
    asOf: input.asOf,
    languageCode: identity.languageCode,
    currency: sold.at(-1)?.currency ?? "USD",
    condition: input.condition ?? "nm",
    gradingCompany: input.gradingCompany ?? null,
    gradeLabel: input.gradeLabel ?? null,
    outlierPolicy,
    features,
    dataQuality: quality.state,
    sampleSize: quality.sample_size,
    coverage: quality.coverage,
    stalenessHours: quality.staleness_hours,
    sourceComposition: quality.source_composition,
  };
}

export async function persistMarketFeatureSnapshot(
  db: Database,
  computed: Awaited<ReturnType<typeof computeMarketFeatures>>,
) {
  const gradingClause =
    computed.gradingCompany == null
      ? isNull(tcgMarketFeatureSnapshot.gradingCompany)
      : eq(tcgMarketFeatureSnapshot.gradingCompany, computed.gradingCompany);
  const existing = await db
    .select({ id: tcgMarketFeatureSnapshot.id })
    .from(tcgMarketFeatureSnapshot)
    .where(
      and(
        eq(tcgMarketFeatureSnapshot.printingId, computed.printingId),
        eq(tcgMarketFeatureSnapshot.asOf, computed.asOf),
        eq(tcgMarketFeatureSnapshot.featureSetKey, MARKET_FEATURE_SET_KEY),
        eq(tcgMarketFeatureSnapshot.featureSetVersion, MARKET_FEATURE_SET_VERSION),
        eq(tcgMarketFeatureSnapshot.condition, computed.condition),
        eq(tcgMarketFeatureSnapshot.outlierPolicy, computed.outlierPolicy),
        gradingClause,
      ),
    )
    .limit(1);
  if (existing[0]) {
    return existing[0];
  }
  const [row] = await db
    .insert(tcgMarketFeatureSnapshot)
    .values({
      id: crypto.randomUUID(),
      printingId: computed.printingId,
      asOf: computed.asOf,
      featureSetKey: MARKET_FEATURE_SET_KEY,
      featureSetVersion: MARKET_FEATURE_SET_VERSION,
      condition: computed.condition,
      gradingCompany: computed.gradingCompany,
      gradeLabel: computed.gradeLabel,
      languageCode: computed.languageCode,
      currency: computed.currency,
      outlierPolicy: computed.outlierPolicy,
      features: computed.features,
      dataQuality: computed.dataQuality,
      sampleSize: computed.sampleSize,
      coverage: computed.coverage.toFixed(6),
      stalenessHours: computed.stalenessHours == null ? null : computed.stalenessHours.toFixed(4),
      sourceComposition: computed.sourceComposition,
    })
    .returning();
  return row!;
}

export async function getMarketFeatureSnapshot(
  db: Database,
  input: { printingId: string; asOf?: Date; outlierPolicy?: MarketOutlierPolicy },
) {
  const rows = await db
    .select()
    .from(tcgMarketFeatureSnapshot)
    .where(eq(tcgMarketFeatureSnapshot.printingId, input.printingId));
  const filtered = rows
    .filter((row) => (input.asOf ? row.asOf.getTime() <= input.asOf.getTime() : true))
    .filter((row) => (input.outlierPolicy ? row.outlierPolicy === input.outlierPolicy : true))
    .sort((a, b) => b.asOf.getTime() - a.asOf.getTime());
  return filtered[0] ?? null;
}

export async function computeMarketFeaturesWithBenchmark(db: Database, input: ComputeFeaturesInput) {
  const ctx = await printingBenchmarkContext(db, input.printingId);
  let benchmarkReturn30d = input.benchmarkReturn30d ?? null;
  if (benchmarkReturn30d == null && ctx) {
    const resolved = await resolveBenchmark(db, {
      printingId: input.printingId,
      gameKey: ctx.gameKey,
      languageCode: ctx.languageCode,
      setKey: ctx.setKey,
      era: "modern",
      asOf: input.asOf,
    });
    if (resolved.status === "ok" && resolved.indexKey) {
      const start = await getIndexLevelAsOf(db, resolved.indexKey, new Date(input.asOf.getTime() - 30 * MS_DAY));
      const end = await getIndexLevelAsOf(db, resolved.indexKey, input.asOf);
      if (start && end) {
        const value = indexReturn(Number(start.indexValue), Number(end.indexValue));
        benchmarkReturn30d = Number.isFinite(value) ? value : null;
      }
    }
  }
  return computeMarketFeatures(db, { ...input, benchmarkReturn30d });
}
