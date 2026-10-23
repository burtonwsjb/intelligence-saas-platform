import {
  MARKET_PRICE_FRESH_HOURS,
  MIN_SALES_FOR_MARKET_CONFIRM,
  OPPORTUNITY_WEIGHTS_V1,
  RECOMMENDATION_THRESHOLDS_V1,
  RECOMMENDATION_VERSION,
  RISK_WEIGHTS_V1,
  SCORE_POLICY_KEY,
  SCORE_MODEL_REVISION,
  SCORE_POLICY_VERSION,
  SCORE_UNCALIBRATED,
  SOCIAL_STRONG_BUY_CAP,
  CONFIDENCE_WEIGHTS_V1,
  LIQUIDITY_WEIGHTS_V1,
} from "./weights.js";

export type ComponentContribution = {
  key: string;
  present: boolean;
  raw: number | null;
  score: number | null;
  weight: number;
  applied_weight: number;
  contribution: number | null;
  skipped_reason?: string;
};

export type ExplanationLine = {
  code: string;
  text: string;
  refs: string[];
};

export type CreatorVote = {
  creatorId: string;
  direction: string;
  languageCode: string | null;
  authorityWeight: number;
  sampleSize: number;
  publishedAt: string;
};

export type SocialStats = {
  mentions_7d: number;
  mentions_prior_7d: number;
  unique_accounts: number;
  unique_content: number;
  engagement_sum: number;
  language_code: string;
};

export type ScoreInputs = {
  printingId: string;
  languageCode: string;
  asOf: string;
  featureSnapshotId?: string | null;
  featureSetVersion?: string | null;
  sampleSize: number;
  /** "reference" when the price series is the daily market price because the printing has too few sales. */
  priceBasis?: "sold" | "reference";
  dataQuality: string;
  stalenessHours: number | null;
  sourceCount: number;
  resolutionCertainty: number;
  returns?: Record<string, { status: string; value: number | null }>;
  volumeMomentum?: { status: string; value: number | null };
  salesVelocity?: { sales_7d?: number; sales_30d?: number; sales_per_day_30d?: { status: string; value: number | null }; median_intersale_ms?: { status: string; value: number | null } };
  supply?: {
    listing_count?: number | null;
    listing_change?: number | null;
    seller_count?: number | null;
    listing_sale_ratio?: { status: string; value: number | null };
    absorption_ratio?: { status: string; value: number | null };
  };
  relativeStrength?: { status: string; value: number | null };
  volatility?: { status: string; value: number | null };
  spreadChange?: { status: string; value: number | null };
  latestSpreadRatio?: number | null;
  manipulation?: {
    thin_volume_spike?: boolean;
    price_jump_without_volume?: boolean;
    supply_disappearance?: boolean;
    outlier_driven?: boolean;
  };
  social?: SocialStats | null;
  creatorVotes?: CreatorVote[];
  scoreVersion?: string;
};

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function signedToScore(value: number, scale: number): number {
  return clamp(50 + (value / scale) * 50);
}

function positiveToScore(value: number, good: number): number {
  return clamp((value / good) * 100);
}

function inverseToScore(value: number, bad: number): number {
  return clamp(100 - (value / bad) * 100);
}

function combine(
  weights: Record<string, number>,
  parts: Record<string, { present: boolean; score: number | null; raw: number | null; skipped_reason?: string }>,
): { total: number; components: ComponentContribution[] } {
  const presentKeys = Object.keys(weights).filter((key) => parts[key]?.present && parts[key]?.score != null);
  const presentWeight = presentKeys.reduce((sum, key) => sum + weights[key]!, 0);
  const components: ComponentContribution[] = [];
  let total = 50;
  if (presentWeight > 0) {
    total = 0;
    for (const key of Object.keys(weights)) {
      const part = parts[key];
      const applied = part?.present && part.score != null ? weights[key]! / presentWeight : 0;
      const contribution = part?.present && part.score != null ? part.score * applied : null;
      if (contribution != null) {
        total += contribution;
      }
      components.push({
        key,
        present: Boolean(part?.present),
        raw: part?.raw ?? null,
        score: part?.score ?? null,
        weight: weights[key]!,
        applied_weight: applied,
        contribution,
        skipped_reason: part?.present ? undefined : (part?.skipped_reason ?? "missing_input"),
      });
    }
  } else {
    for (const key of Object.keys(weights)) {
      const part = parts[key];
      components.push({
        key,
        present: false,
        raw: part?.raw ?? null,
        score: null,
        weight: weights[key]!,
        applied_weight: 0,
        contribution: null,
        skipped_reason: part?.skipped_reason ?? "missing_input",
      });
    }
  }
  return { total: clamp(total), components };
}

export function creatorConsensus(votes: CreatorVote[], languageCode: string) {
  const usable = votes.filter((vote) => vote.languageCode == null || vote.languageCode === languageCode);
  const weighted = usable.map((vote) => {
    // "avoid" is a call not to buy: it counts against the card like "bearish".
    const sign = vote.direction === "bullish" ? 1 : vote.direction === "bearish" || vote.direction === "avoid" ? -1 : 0;
    return { ...vote, sign, w: vote.authorityWeight };
  });
  const totalW = weighted.reduce((sum, vote) => sum + vote.w, 0);
  if (totalW < 0.05 || weighted.length === 0) {
    return {
      present: false as const,
      score: null as number | null,
      raw: null as number | null,
      disagreement: null as number | null,
      total_weight: totalW,
      n: weighted.length,
      skipped_reason: "weak_creator_sample",
    };
  }
  const mean = weighted.reduce((sum, vote) => sum + vote.w * vote.sign, 0) / totalW;
  const disagreement =
    weighted.reduce((sum, vote) => sum + vote.w * Math.abs(vote.sign - mean), 0) / totalW;
  return {
    present: true as const,
    score: signedToScore(mean, 1),
    raw: mean,
    disagreement,
    total_weight: totalW,
    n: weighted.length,
  };
}

/** Mean creator direction (-1..1) inside this band reads as split, not as a lean. */
const CONSENSUS_NEUTRAL_BAND = 0.15;
const VOLATILITY_ELEVATED = 0.08;
const PRICE_MOMENTUM_SCALE = 0.3;

export function creatorConsensusText(mean: number, n: number): string {
  const calls = `${n} creator call${n === 1 ? "" : "s"}`;
  if (mean >= CONSENSUS_NEUTRAL_BAND) return `${calls} lean bullish, weighted by each creator's track record`;
  if (mean <= -CONSENSUS_NEUTRAL_BAND) return `${calls} lean bearish, weighted by each creator's track record`;
  return `${calls}, split or neutral overall`;
}

export function socialMomentum(social: SocialStats | null) {
  if (!social) {
    return { present: false as const, score: null as number | null, raw: null as number | null, skipped_reason: "missing_input" };
  }
  if (social.mentions_7d === 0 && social.unique_content === 0) {
    return { present: false as const, score: null as number | null, raw: null as number | null, skipped_reason: "missing_input" };
  }
  const accel =
    social.mentions_prior_7d >= 2 ? social.mentions_7d / social.mentions_prior_7d - 1 : social.mentions_7d >= 3 ? 1 : 0;
  const uniqueBoost = Math.min(1, social.unique_accounts / 8 + social.unique_content / 8);
  const engagementBoost = Math.min(1, social.engagement_sum / 50_000);
  const score = clamp(40 + 30 * Math.max(-1, Math.min(2, accel)) + 20 * uniqueBoost + 10 * engagementBoost);
  return { present: true as const, score, raw: accel };
}

export function recommend(input: {
  opportunity: number;
  risk: number;
  confidence: number;
  liquidity: number;
  sampleSize: number;
  dataQuality: string;
  marketConfirmed: boolean;
  hypeUnconfirmed: boolean;
}): { label: string; reasons: string[] } {
  const t = RECOMMENDATION_THRESHOLDS_V1;
  if (
    input.sampleSize < t.insufficient_sample ||
    input.dataQuality === "insufficient_data" ||
    input.confidence < t.insufficient_confidence
  ) {
    return { label: "insufficient_data", reasons: ["insufficient_data_gate"] };
  }
  if (input.hypeUnconfirmed || !input.marketConfirmed) {
    if (input.opportunity >= t.watch.opportunity && input.risk <= t.watch.risk_max) {
      return { label: "watch", reasons: ["market_unconfirmed_cap"] };
    }
  }
  if (
    input.marketConfirmed &&
    !input.hypeUnconfirmed &&
    input.opportunity >= t.strong_buy.opportunity &&
    input.risk <= t.strong_buy.risk_max &&
    input.confidence >= t.strong_buy.confidence &&
    input.liquidity >= t.strong_buy.liquidity
  ) {
    return { label: "strong_buy", reasons: ["thresholds.strong_buy"] };
  }
  if (
    input.marketConfirmed &&
    !input.hypeUnconfirmed &&
    input.opportunity >= t.buy.opportunity &&
    input.risk <= t.buy.risk_max &&
    input.confidence >= t.buy.confidence &&
    input.liquidity >= t.buy.liquidity
  ) {
    return { label: "buy", reasons: ["thresholds.buy"] };
  }
  if (input.opportunity >= t.watch.opportunity && input.risk <= t.watch.risk_max) {
    return { label: "watch", reasons: ["thresholds.watch"] };
  }
  if (input.opportunity <= t.strong_sell.opportunity_max && input.risk >= t.strong_sell.risk) {
    return { label: "strong_sell", reasons: ["thresholds.strong_sell"] };
  }
  if (input.opportunity <= t.sell.opportunity_max && input.risk >= t.sell.risk) {
    return { label: "sell", reasons: ["thresholds.sell"] };
  }
  if (input.opportunity <= t.reduce.opportunity_max && input.risk >= t.reduce.risk) {
    return { label: "reduce", reasons: ["thresholds.reduce"] };
  }
  // A weak reading backed by a current market price is a sell-side reading
  // even when risk is low (a steadily falling card is not a "watch").
  if (input.marketConfirmed && input.confidence >= t.buy.confidence) {
    if (input.opportunity <= t.market_sell.opportunity_max) {
      return { label: "sell", reasons: ["thresholds.market_sell"] };
    }
    if (input.opportunity <= t.market_reduce.opportunity_max) {
      return { label: "reduce", reasons: ["thresholds.market_reduce"] };
    }
  }
  if (input.opportunity >= t.hold_min_opportunity) {
    return { label: "hold", reasons: ["thresholds.hold"] };
  }
  return { label: "watch", reasons: ["thresholds.default_watch"] };
}

function metricPart(metric: { status?: string; value?: number | null } | undefined, map: (value: number) => number) {
  if (!metric || metric.status !== "ok" || metric.value == null) {
    return { present: false as const, score: null as number | null, raw: null as number | null, skipped_reason: "insufficient_data" };
  }
  return { present: true as const, score: map(metric.value), raw: metric.value };
}

export function scoreFromInputs(input: ScoreInputs) {
  const sales7 = input.salesVelocity?.sales_7d ?? 0;
  const sales30 = input.salesVelocity?.sales_30d ?? 0;
  const consensus = creatorConsensus(input.creatorVotes ?? [], input.languageCode);
  const social = socialMomentum(input.social ?? null);
  const referenceBasis = input.priceBasis === "reference";
  // Market evidence is a current price, sold or market: recent sales confirm
  // it, and so does a daily market price series that is up to date.
  const freshPrice =
    input.sampleSize >= RECOMMENDATION_THRESHOLDS_V1.insufficient_sample &&
    input.stalenessHours != null &&
    input.stalenessHours <= MARKET_PRICE_FRESH_HOURS;
  const marketConfirmed = sales7 >= MIN_SALES_FOR_MARKET_CONFIRM || freshPrice;
  const hypeUnconfirmed = Boolean(social.present && (social.score ?? 0) >= 65 && !marketConfirmed);

  const opportunityParts = {
    // ±30% maps to 0/100, so ordinary monthly moves in cards spread out instead of pinning at the ends.
    price_momentum: metricPart(input.returns?.["30d"] ?? input.returns?.["7d"], (value) => signedToScore(value, PRICE_MOMENTUM_SCALE)),
    volume_momentum: metricPart(input.volumeMomentum, (value) => signedToScore(value, 1)),
    // A market-price series has no sale counts: zero recorded sales is unknown demand, not no demand.
    sales_velocity: referenceBasis
      ? { present: false as const, score: null as number | null, raw: null as number | null, skipped_reason: "market_price_basis" }
      : metricPart(input.salesVelocity?.sales_per_day_30d, (value) => positiveToScore(value, 1)),
    relative_strength: metricPart(input.relativeStrength, (value) => signedToScore(value, 0.15)),
    supply_absorption: metricPart(input.supply?.absorption_ratio, (value) => positiveToScore(value, 1)),
    creator_consensus: consensus.present
      ? { present: true as const, score: consensus.score, raw: consensus.raw }
      : { present: false as const, score: null, raw: null, skipped_reason: consensus.skipped_reason ?? "missing_input" },
    social_momentum: social.present
      ? { present: true as const, score: social.score, raw: social.raw }
      : { present: false as const, score: null, raw: null, skipped_reason: social.skipped_reason ?? "missing_input" },
  };
  let opportunity = combine(OPPORTUNITY_WEIGHTS_V1, opportunityParts);
  if (hypeUnconfirmed) {
    opportunity = { ...opportunity, total: Math.min(opportunity.total, SOCIAL_STRONG_BUY_CAP) };
  }

  const supplyShock = Boolean(
    input.manipulation?.supply_disappearance ||
      (input.supply?.listing_change != null && input.supply.listing_change < 0 && sales7 === 0),
  );
  const socialUnconfirmedPresent = hypeUnconfirmed || Boolean(input.manipulation?.thin_volume_spike);
  const riskParts = {
    volatility: metricPart(input.volatility, (value) => positiveToScore(value, 0.15)),
    // A market-price series carries no sale counts, so liquidity is unknown rather than zero.
    thin_liquidity: referenceBasis
      ? { present: false as const, score: null as number | null, raw: sales7, skipped_reason: "market_price_basis" }
      : {
          present: true as const,
          score: inverseToScore(sales7, 10),
          raw: sales7,
        },
    spread: input.latestSpreadRatio == null
      ? { present: false as const, score: null, raw: null, skipped_reason: "missing_input" }
      : { present: true as const, score: clamp((input.latestSpreadRatio - 1) * 200), raw: input.latestSpreadRatio },
    low_sample: { present: true as const, score: inverseToScore(input.sampleSize, 20), raw: input.sampleSize },
    outlier_dependence: {
      present: true as const,
      score: input.manipulation?.outlier_driven || input.dataQuality === "outlier_dependent" ? 80 : 15,
      raw: input.manipulation?.outlier_driven ? 1 : 0,
    },
    social_unconfirmed: socialUnconfirmedPresent
      ? {
          present: true as const,
          score: hypeUnconfirmed ? 85 : 70,
          raw: hypeUnconfirmed ? 1 : 0,
        }
      : { present: false as const, score: null as number | null, raw: 0, skipped_reason: "missing_input" },
    supply_shock: supplyShock
      ? { present: true as const, score: 75, raw: input.supply?.listing_change ?? null }
      : {
          present: false as const,
          score: null as number | null,
          raw: input.supply?.listing_change ?? null,
          skipped_reason: "missing_input",
        },
    creator_disagreement: consensus.present && consensus.disagreement != null
      ? { present: true as const, score: clamp(consensus.disagreement * 100), raw: consensus.disagreement }
      : { present: false as const, score: null, raw: null, skipped_reason: "missing_input" },
  };
  const risk = combine(RISK_WEIGHTS_V1, riskParts);

  const confidenceParts = {
    market_sample: { present: true as const, score: clamp((input.sampleSize / 12) * 100), raw: input.sampleSize },
    source_coverage: { present: true as const, score: clamp(input.sourceCount * 40), raw: input.sourceCount },
    freshness: input.stalenessHours == null
      ? { present: false as const, score: null, raw: null, skipped_reason: "missing_input" }
      : { present: true as const, score: inverseToScore(input.stalenessHours, 24 * 21), raw: input.stalenessHours },
    resolution_certainty: { present: true as const, score: clamp(input.resolutionCertainty * 100), raw: input.resolutionCertainty },
    creator_reliability: consensus.present
      ? { present: true as const, score: clamp(consensus.total_weight * 200), raw: consensus.total_weight }
      : { present: false as const, score: null, raw: null, skipped_reason: "weak_creator_sample" },
    cross_source: { present: true as const, score: clamp(input.sourceCount >= 2 ? 80 : 35), raw: input.sourceCount },
  };
  const confidence = combine(CONFIDENCE_WEIGHTS_V1, confidenceParts);

  const liquidityParts = {
    sales_frequency: referenceBasis
      ? { present: false as const, score: null as number | null, raw: sales7, skipped_reason: "market_price_basis" }
      : { present: true as const, score: clamp((sales7 / 8) * 100), raw: sales7 },
    intersale_time: metricPart(input.salesVelocity?.median_intersale_ms, (value) => inverseToScore(value / 86_400_000, 14)),
    listing_depth: input.supply?.listing_count == null
      ? { present: false as const, score: null, raw: null, skipped_reason: "missing_input" }
      : { present: true as const, score: positiveToScore(input.supply.listing_count, 20), raw: input.supply.listing_count },
    spread: input.latestSpreadRatio == null
      ? { present: false as const, score: null, raw: null, skipped_reason: "missing_input" }
      : { present: true as const, score: inverseToScore(Math.max(0, input.latestSpreadRatio - 1), 0.35), raw: input.latestSpreadRatio },
    seller_diversity: input.supply?.seller_count == null
      ? { present: false as const, score: null, raw: null, skipped_reason: "missing_input" }
      : { present: true as const, score: positiveToScore(input.supply.seller_count, 12), raw: input.supply.seller_count },
    historical_sales: referenceBasis
      ? { present: false as const, score: null as number | null, raw: sales30, skipped_reason: "market_price_basis" }
      : { present: true as const, score: clamp((sales30 / 20) * 100), raw: sales30 },
  };
  const liquidity = combine(LIQUIDITY_WEIGHTS_V1, liquidityParts);

  const rec = recommend({
    opportunity: opportunity.total,
    risk: risk.total,
    confidence: confidence.total,
    liquidity: liquidity.total,
    sampleSize: input.sampleSize,
    dataQuality: input.dataQuality,
    marketConfirmed,
    hypeUnconfirmed,
  });

  const explanations: ExplanationLine[] = [];
  // Customer-facing sentences: the card list shows the first one as "Why".
  if (consensus.present) {
    explanations.push({
      code: "creator_consensus",
      text: creatorConsensusText(consensus.raw!, consensus.n),
      refs: ["authority.v2"],
    });
  }
  const priceReturn = input.returns?.["30d"]?.status === "ok" ? { days: 30, metric: input.returns["30d"] } : input.returns?.["7d"]?.status === "ok" ? { days: 7, metric: input.returns["7d"] } : null;
  if (priceReturn && priceReturn.metric.value != null) {
    const pct = priceReturn.metric.value * 100;
    explanations.push({
      code: priceReturn.days === 30 ? "price_return_30d" : "price_return_7d",
      text:
        Math.abs(pct) < 0.05
          ? `${referenceBasis ? "Market price" : "Sold price"} flat over ${priceReturn.days} days`
          : `${referenceBasis ? "Market price" : "Sold price"} ${pct > 0 ? "up" : "down"} ${Math.abs(pct).toFixed(1)}% over ${priceReturn.days} days`,
      refs: [`features.v1.returns.${priceReturn.days}d`],
    });
  }
  if (input.volumeMomentum?.status === "ok" && input.volumeMomentum.value != null) {
    const pct = input.volumeMomentum.value * 100;
    explanations.push({
      code: "volume_momentum",
      text: `Sales ${pct >= 0 ? "up" : "down"} ${Math.abs(pct).toFixed(0)}% on the week before`,
      refs: ["features.v1.volume_momentum"],
    });
  }
  if (input.supply?.listing_change != null && input.supply.listing_change !== 0) {
    const change = input.supply.listing_change;
    explanations.push({
      code: "listings",
      text: `${Math.abs(change)} ${change > 0 ? "more" : "fewer"} copies listed for sale`,
      refs: ["features.v1.supply"],
    });
  }
  if (input.relativeStrength?.status === "ok" && input.relativeStrength.value != null) {
    const pct = input.relativeStrength.value * 100;
    explanations.push({
      code: "relative_strength",
      text: `${pct >= 0 ? "Beating" : "Trailing"} similar cards by ${Math.abs(pct).toFixed(1)}%`,
      refs: ["features.v1.relative_strength"],
    });
  }
  explanations.push({
    code: "liquidity",
    text: !liquidity.components.some((part) => part.present)
      ? "No recent sales or listings recorded, so how easily it sells is unknown"
      : `${liquidity.total >= 60 ? "Sells easily" : liquidity.total >= 40 ? "Sells at a moderate pace" : "Sells slowly"}`,
    refs: ["score.v1.liquidity"],
  });
  // Volatility is a 30-day standard deviation of returns: only call it out when it is large.
  if (input.volatility?.status === "ok" && (input.volatility.value ?? 0) >= VOLATILITY_ELEVATED) {
    explanations.push({
      code: "volatility",
      text: "Price swings a lot",
      refs: ["features.v1.volatility"],
    });
  }
  if (hypeUnconfirmed) {
    explanations.push({
      code: "hype_unconfirmed",
      text: "Lots of social talk without a current market price to back it, so Strong buy is blocked",
      refs: ["phase09.social", "score.v1.hype_gate"],
    });
  }
  explanations.push({
    code: "recommendation",
    text: `recommendation ${rec.label} (${RECOMMENDATION_VERSION})`,
    refs: [RECOMMENDATION_VERSION, SCORE_POLICY_VERSION],
  });

  return {
    printingId: input.printingId,
    asOf: input.asOf,
    languageCode: input.languageCode,
    policyKey: SCORE_POLICY_KEY,
    policyVersion: SCORE_POLICY_VERSION,
    scoreVersion: input.scoreVersion ?? SCORE_POLICY_VERSION,
    recommendationVersion: RECOMMENDATION_VERSION,
    uncalibrated: SCORE_UNCALIBRATED,
    opportunity: opportunity.total,
    risk: risk.total,
    confidence: confidence.total,
    liquidity: liquidity.total,
    recommendation: rec.label,
    dataQuality: rec.label === "insufficient_data" ? "insufficient_data" : input.dataQuality,
    featureSnapshotId: input.featureSnapshotId ?? null,
    components: {
      opportunity: opportunity.components,
      risk: risk.components,
      confidence: confidence.components,
      liquidity: liquidity.components,
      market_confirmed: marketConfirmed,
      price_basis: input.priceBasis ?? "sold",
      model_revision: SCORE_MODEL_REVISION,
      price_points: input.sampleSize,
      hype_unconfirmed: hypeUnconfirmed,
      creator_consensus: consensus,
      social,
      feature_set_version: input.featureSetVersion ?? null,
    },
    explanations,
  };
}
