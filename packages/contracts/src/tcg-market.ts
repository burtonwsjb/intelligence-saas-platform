export const TCG_MARKET_SOURCES = [
  "tcg_card_central",
  "tcgplayer",
  "ebay",
  "manual",
  "fixture",
] as const;

export type TcgMarketSourceKey = (typeof TCG_MARKET_SOURCES)[number];

export const TCG_MARKET_TYPES = [
  "marketplace_listing",
  "marketplace_sold",
  "market_price",
  "direct_sale",
  "manual_observation",
] as const;

export type TcgMarketType = (typeof TCG_MARKET_TYPES)[number];

export const TCG_PRICE_TYPES = ["asking", "sold", "reference", "bid"] as const;
export type TcgPriceType = (typeof TCG_PRICE_TYPES)[number];

export const TCG_CONDITIONS = ["nm", "lp", "mp", "hp", "dmg", "unknown"] as const;
export type TcgCondition = (typeof TCG_CONDITIONS)[number];

export const TCG_GRADING_COMPANIES = ["psa", "bgs", "cgc", "sgc", "other"] as const;
export type TcgGradingCompany = (typeof TCG_GRADING_COMPANIES)[number];

export const TCG_CURRENCIES = [
  "USD",
  "JPY",
  "EUR",
  "GBP",
  "CAD",
  "AUD",
  "CHF",
  "CNY",
  "KRW",
  "SGD",
  "HKD",
  "TWD",
] as const;

export type TcgCurrency = (typeof TCG_CURRENCIES)[number];

export const TCG_MARKET_QUALITY_LABELS = [
  "verified",
  "normal",
  "suspect",
  "outlier",
  "incomplete",
] as const;

export type TcgMarketQualityLabel = (typeof TCG_MARKET_QUALITY_LABELS)[number];

export const TCG_MARKET_EVENT_TYPES = [
  "tcg.market.sold",
  "tcg.market.listing_snapshot",
  "tcg.market.reference_price",
  "tcg.market.volume_snapshot",
] as const;

export type TcgMarketEventType = (typeof TCG_MARKET_EVENT_TYPES)[number];

export const TCG_MARKET_METRIC_KEYS = [
  "market.price.sold",
  "market.price.ask.low",
  "market.price.reference",
  "market.listings.active",
  "market.sales.count",
  "market.volume.gross",
] as const;

export const TCG_MARKET_AGGREGATION_KINDS = ["event", "window"] as const;

export const TCG_SPREAD_FORMULA = "lowest_ask_minus_latest_sold" as const;
export const TCG_SPREAD_VERSION = "spread.v1" as const;
export const TCG_OUTLIER_VERSION = "outlier.v1" as const;

export class TcgMarketContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TcgMarketContractError";
  }
}

export function isTcgMarketEventType(value: string): value is TcgMarketEventType {
  return (TCG_MARKET_EVENT_TYPES as readonly string[]).includes(value);
}

export function isTcgCondition(value: string): value is TcgCondition {
  return (TCG_CONDITIONS as readonly string[]).includes(value);
}

export function isTcgCurrency(value: string): value is TcgCurrency {
  return (TCG_CURRENCIES as readonly string[]).includes(value);
}

export function parseTcgCurrency(value: unknown): TcgCurrency {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value) || !isTcgCurrency(value)) {
    throw new TcgMarketContractError("Currency is required and must be an ISO 4217 uppercase code.");
  }
  return value;
}

export function parseTcgCondition(value: unknown): TcgCondition {
  if (typeof value !== "string" || !isTcgCondition(value)) {
    throw new TcgMarketContractError("Condition is required and must be a catalog value.");
  }
  return value;
}

export function defaultPriceType(marketType: TcgMarketType): TcgPriceType {
  if (marketType === "marketplace_listing") {
    return "asking";
  }
  if (marketType === "market_price") {
    return "reference";
  }
  if (marketType === "marketplace_sold" || marketType === "direct_sale") {
    return "sold";
  }
  return "reference";
}

export function computeTcgAskSoldSpread(input: {
  lowestAsk: number;
  latestSold: number;
}): { spread_abs: number | null; spread_ratio: number | null; formula: typeof TCG_SPREAD_FORMULA; version: typeof TCG_SPREAD_VERSION } {
  if (!Number.isFinite(input.lowestAsk) || !Number.isFinite(input.latestSold) || input.latestSold <= 0) {
    return {
      spread_abs: null,
      spread_ratio: null,
      formula: TCG_SPREAD_FORMULA,
      version: TCG_SPREAD_VERSION,
    };
  }
  return {
    spread_abs: input.lowestAsk - input.latestSold,
    spread_ratio: input.lowestAsk / input.latestSold,
    formula: TCG_SPREAD_FORMULA,
    version: TCG_SPREAD_VERSION,
  };
}

export type TcgMarketRecord = {
  provider: string;
  provider_record_id: string;
  event_type: TcgMarketEventType | string;
  market_type: TcgMarketType;
  price_type?: TcgPriceType;
  observed_at: string;
  currency: string;
  condition: TcgCondition;
  raw_condition?: string;
  grading_company?: string | null;
  grade_label?: string | null;
  grade_numeric?: number | null;
  certification_number?: string | null;
  price?: number | null;
  quantity?: number | null;
  listing_count?: number | null;
  sales_count?: number | null;
  volume_value?: number | null;
  low_price?: number | null;
  high_price?: number | null;
  median_price?: number | null;
  average_price?: number | null;
  bid_count?: number | null;
  seller_count?: number | null;
  shipping_amount?: number | null;
  tax_amount?: number | null;
  fee_amount?: number | null;
  window_seconds?: number | null;
  aggregation_kind?: "event" | "window";
  source_reference?: string | null;
  printing?: {
    game?: string;
    set?: string;
    collector_number?: string;
    language?: string;
    variant?: string;
  };
  external_id?: {
    source_namespace: string;
    identifier_type: string;
    identifier_value: string;
  };
  attributes?: Record<string, unknown>;
};

export function parseTcgMarketRecord(input: TcgMarketRecord): TcgMarketRecord {
  const provider = input.provider?.trim();
  const provider_record_id = input.provider_record_id?.trim();
  if (!provider) {
    throw new TcgMarketContractError("provider is required.");
  }
  if (!provider_record_id) {
    throw new TcgMarketContractError("provider_record_id is required.");
  }
  if (!(TCG_MARKET_TYPES as readonly string[]).includes(input.market_type)) {
    throw new TcgMarketContractError("market_type is invalid.");
  }
  parseTcgCurrency(input.currency);
  parseTcgCondition(input.condition);
  if (!input.observed_at) {
    throw new TcgMarketContractError("observed_at is required.");
  }
  if (input.price != null && !(typeof input.price === "number" && Number.isFinite(input.price) && input.price > 0)) {
    throw new TcgMarketContractError("price must be a positive finite number.");
  }
  if (!input.printing && !input.external_id) {
    throw new TcgMarketContractError("Exact printing reference or external id is required.");
  }
  return input;
}
