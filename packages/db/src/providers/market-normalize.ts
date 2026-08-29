import type { TcgMarketRecordInput } from "../tcg/market-identity.js";
import { parseTcgMarketRecord } from "../tcg/market-identity.js";
import { MARKET_NORMALIZER_VERSION } from "./catalog.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function printingFrom(raw: Record<string, unknown>): TcgMarketRecordInput["printing"] {
  const printing = asRecord(raw.printing ?? raw.identity);
  const game = asString(printing.game ?? printing.game_key ?? raw.game);
  const set = asString(printing.set ?? printing.set_key ?? raw.set);
  const collector_number = asString(
    printing.collector_number ?? printing.collectorNumber ?? raw.collector_number,
  );
  const language = asString(printing.language ?? printing.language_code ?? raw.language);
  const variant = asString(printing.variant ?? printing.variant_key ?? raw.variant);
  if (!game && !set && !collector_number && !language) {
    return undefined;
  }
  return { game, set, collector_number, language, variant };
}

function externalFrom(raw: Record<string, unknown>, fallbackNamespace: string): TcgMarketRecordInput["external_id"] {
  const external = asRecord(raw.external_id ?? raw.provider_ref);
  const identifier_value = asString(
    external.identifier_value ?? raw.catalog_id ?? raw.product_id ?? raw.printing_id,
  );
  if (!identifier_value) {
    return undefined;
  }
  return {
    source_namespace: asString(external.source_namespace) ?? fallbackNamespace,
    identifier_type: asString(external.identifier_type) ?? `${fallbackNamespace}_catalog_id`,
    identifier_value,
  };
}

export function normalizeMarketVendorPayload(
  provider: "tcg_card_central" | "tcgplayer" | "ebay",
  raw: unknown,
): TcgMarketRecordInput {
  const row = asRecord(raw);
  const marketType =
    asString(row.market_type) ??
    (asString(row.price_type) === "sold" || asString(row.kind) === "sold"
      ? "marketplace_sold"
      : asString(row.kind) === "listing"
        ? "marketplace_listing"
        : "market_price");
  const priceType =
    asString(row.price_type) ??
    (marketType === "marketplace_sold" ? "sold" : marketType === "marketplace_listing" ? "asking" : "reference");
  const eventType =
    asString(row.event_type) ??
    (priceType === "sold"
      ? "tcg.market.sold"
      : priceType === "asking"
        ? "tcg.market.listing_snapshot"
        : "tcg.market.reference_price");
  const record: TcgMarketRecordInput = {
    provider,
    provider_record_id: asString(row.provider_record_id ?? row.id ?? row.source_record_id) ?? "",
    event_type: eventType,
    market_type: marketType,
    price_type: priceType,
    observed_at: asString(row.observed_at ?? row.source_timestamp ?? row.sold_at) ?? "",
    currency: (asString(row.currency) ?? "USD").toUpperCase(),
    condition: asString(row.condition) ?? "unknown",
    raw_condition: asString(row.raw_condition),
    grading_company: asString(row.grading_company) ?? null,
    grade_label: asString(row.grade_label) ?? null,
    grade_numeric: asNumber(row.grade_numeric) ?? null,
    certification_number: asString(row.certification_number) ?? null,
    price: asNumber(row.price) ?? null,
    quantity: asNumber(row.quantity) ?? null,
    listing_count: asNumber(row.listing_count) ?? null,
    sales_count: asNumber(row.sales_count) ?? null,
    volume_value: asNumber(row.volume_value) ?? null,
    low_price: asNumber(row.low_price ?? row.lowest_ask) ?? null,
    high_price: asNumber(row.high_price) ?? null,
    median_price: asNumber(row.median_price) ?? null,
    average_price: asNumber(row.average_price) ?? null,
    bid_count: asNumber(row.bid_count) ?? null,
    seller_count: asNumber(row.seller_count) ?? null,
    shipping_amount: asNumber(row.shipping_amount) ?? null,
    tax_amount: asNumber(row.tax_amount) ?? null,
    fee_amount: asNumber(row.fee_amount) ?? null,
    window_seconds: asNumber(row.window_seconds) ?? null,
    aggregation_kind: asString(row.aggregation_kind) === "window" ? "window" : "event",
    source_reference: asString(row.source_reference ?? row.url) ?? null,
    printing: printingFrom(row),
    external_id: externalFrom(row, provider),
    attributes: {
      ...asRecord(row.attributes),
      provenance: {
        provider,
        external_record_id: asString(row.provider_record_id ?? row.id),
        source_url: asString(row.source_reference ?? row.url) ?? null,
        source_timestamp: asString(row.observed_at ?? row.source_timestamp),
        normalizer_version: MARKET_NORMALIZER_VERSION,
      },
    },
  };
  return parseTcgMarketRecord(record);
}

export function normalizeMarketVendorList(
  provider: "tcg_card_central" | "tcgplayer" | "ebay",
  raw: unknown,
): TcgMarketRecordInput[] {
  const root = asRecord(raw);
  const items = Array.isArray(raw) ? raw : Array.isArray(root.items) ? root.items : Array.isArray(root.data) ? root.data : [];
  return items.map((item) => normalizeMarketVendorPayload(provider, item));
}
