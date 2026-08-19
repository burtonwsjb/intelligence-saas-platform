import { createHash } from "node:crypto";

export const TCG_MARKET_SOURCES = [
  "tcg_card_central",
  "tcgplayer",
  "ebay",
  "manual",
  "fixture",
] as const;

export const TCG_MARKET_TYPES = [
  "marketplace_listing",
  "marketplace_sold",
  "market_price",
  "direct_sale",
  "manual_observation",
] as const;

export const TCG_PRICE_TYPES = ["asking", "sold", "reference", "bid"] as const;
export const TCG_CONDITIONS = ["nm", "lp", "mp", "hp", "dmg", "unknown"] as const;
export const TCG_GRADING_COMPANIES = ["psa", "bgs", "cgc", "sgc", "other"] as const;
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
export const TCG_MARKET_EVENT_TYPES = [
  "tcg.market.sold",
  "tcg.market.listing_snapshot",
  "tcg.market.reference_price",
  "tcg.market.volume_snapshot",
] as const;
export const TCG_OUTLIER_VERSION = "outlier.v1";
export const TCG_SPREAD_FORMULA = "lowest_ask_minus_latest_sold";
export const TCG_SPREAD_VERSION = "spread.v1";

export class TcgMarketValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TcgMarketValidationError";
  }
}

export class TcgMarketRevisionError extends Error {
  constructor() {
    super("Market source record fingerprint conflict; original snapshot was not rewritten.");
    this.name = "TcgMarketRevisionError";
  }
}

export type TcgMarketRecordInput = {
  provider: string;
  provider_record_id: string;
  event_type: string;
  market_type: string;
  price_type?: string;
  observed_at: string;
  currency: string;
  condition: string;
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
  aggregation_kind?: string;
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

function requireCatalog(value: string, catalog: readonly string[], label: string): string {
  if (!catalog.includes(value)) {
    throw new TcgMarketValidationError(`${label} is invalid.`);
  }
  return value;
}

export function parseTcgCurrency(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value) || !(TCG_CURRENCIES as readonly string[]).includes(value)) {
    throw new TcgMarketValidationError("Currency is required and must be an ISO 4217 uppercase code.");
  }
  return value;
}

export function parseTcgCondition(value: unknown): string {
  if (typeof value !== "string" || !(TCG_CONDITIONS as readonly string[]).includes(value)) {
    throw new TcgMarketValidationError("Condition is required and must be a catalog value.");
  }
  return value;
}

export function parsePositiveAmount(value: unknown, label: string): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TcgMarketValidationError(`${label} must be a positive finite number.`);
  }
  return value.toString();
}

export function parseNonNegativeInt(value: unknown, label: string): number | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TcgMarketValidationError(`${label} must be a non-negative integer.`);
  }
  return value;
}

export function defaultPriceType(marketType: string): string {
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

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

export function marketFingerprint(input: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(stableValue(input))).digest("hex");
}

export function stableMarketId(prefix: string, parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32)}`;
}

export function computeTcgAskSoldSpread(input: { lowestAsk: number; latestSold: number }) {
  if (!Number.isFinite(input.lowestAsk) || !Number.isFinite(input.latestSold) || input.latestSold <= 0) {
    return {
      spread_abs: null as number | null,
      spread_ratio: null as number | null,
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

export function rollingMedian(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

export function flagOutlierV1(input: { price: number | null; priorPrices: number[]; quantity: number | null }) {
  if (input.quantity != null && input.quantity > 1000) {
    return { outlier_flag: true, outlier_reason: "extreme_quantity", outlier_algorithm_version: TCG_OUTLIER_VERSION };
  }
  if (input.price == null || input.priorPrices.length < 3) {
    return { outlier_flag: false, outlier_reason: null as string | null, outlier_algorithm_version: TCG_OUTLIER_VERSION };
  }
  const median = rollingMedian(input.priorPrices);
  if (median == null || median <= 0) {
    return { outlier_flag: false, outlier_reason: null as string | null, outlier_algorithm_version: TCG_OUTLIER_VERSION };
  }
  if (input.price > median * 5 || input.price < median * 0.2) {
    return {
      outlier_flag: true,
      outlier_reason: "outside_rolling_median",
      outlier_algorithm_version: TCG_OUTLIER_VERSION,
    };
  }
  return { outlier_flag: false, outlier_reason: null as string | null, outlier_algorithm_version: TCG_OUTLIER_VERSION };
}

export function parseTcgMarketRecord(input: TcgMarketRecordInput): TcgMarketRecordInput {
  const provider = input.provider?.trim();
  const provider_record_id = input.provider_record_id?.trim();
  if (!provider) {
    throw new TcgMarketValidationError("provider is required.");
  }
  if (!provider_record_id) {
    throw new TcgMarketValidationError("provider_record_id is required.");
  }
  requireCatalog(provider, TCG_MARKET_SOURCES, "provider");
  requireCatalog(input.market_type, TCG_MARKET_TYPES, "market_type");
  requireCatalog(input.event_type, TCG_MARKET_EVENT_TYPES, "event_type");
  parseTcgCurrency(input.currency);
  parseTcgCondition(input.condition);
  if (Number.isNaN(Date.parse(input.observed_at))) {
    throw new TcgMarketValidationError("observed_at must be an ISO timestamp.");
  }
  parsePositiveAmount(input.price, "price");
  parsePositiveAmount(input.low_price, "low_price");
  parsePositiveAmount(input.high_price, "high_price");
  parsePositiveAmount(input.median_price, "median_price");
  parsePositiveAmount(input.average_price, "average_price");
  parsePositiveAmount(input.volume_value, "volume_value");
  parseNonNegativeInt(input.quantity, "quantity");
  parseNonNegativeInt(input.listing_count, "listing_count");
  parseNonNegativeInt(input.sales_count, "sales_count");
  if (input.grading_company != null && input.grading_company !== "") {
    requireCatalog(input.grading_company, TCG_GRADING_COMPANIES, "grading_company");
  }
  if (input.price_type) {
    requireCatalog(input.price_type, TCG_PRICE_TYPES, "price_type");
  }
  const hasPrinting =
    Boolean(input.printing?.game && input.printing.set && input.printing.collector_number && input.printing.language && input.printing.variant);
  if (!hasPrinting && !input.external_id && !input.printing) {
    throw new TcgMarketValidationError("Exact printing reference or external id is required.");
  }
  return { ...input, provider, provider_record_id };
}

export function resolveWindow(preset: "24h" | "7d" | "30d" | "90d" | "1y" | "all", now = new Date()) {
  const to = now;
  if (preset === "all") {
    return { from: new Date("1970-01-01T00:00:00.000Z"), to };
  }
  const ms =
    preset === "24h"
      ? 24 * 60 * 60 * 1000
      : preset === "7d"
        ? 7 * 24 * 60 * 60 * 1000
        : preset === "30d"
          ? 30 * 24 * 60 * 60 * 1000
          : preset === "90d"
            ? 90 * 24 * 60 * 60 * 1000
            : 365 * 24 * 60 * 60 * 1000;
  return { from: new Date(to.getTime() - ms), to };
}
