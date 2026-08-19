import { describe, expect, it } from "vitest";
import {
  canonicalEntityKey,
  isGenericEventType,
  isValidMetricKey,
  normalizeIdentifierValue,
  parseConfidence,
  parseEntityType,
  parseGenericSourceEventBody,
} from "./kernel.js";

describe("kernel contracts", () => {
  it("accepts v1 generic event types including pricing.snapshot", () => {
    expect(isGenericEventType("pricing.snapshot")).toBe(true);
    expect(isGenericEventType("metric.snapshot")).toBe(true);
    expect(isGenericEventType("tcg.card.price")).toBe(false);
    expect(
      parseGenericSourceEventBody({
        event_type: "pricing.snapshot",
        occurred_at: "2026-08-16T00:00:00.000Z",
        idempotency_key: "src:price:sku_123:2026-08-16T00:00:00Z",
        entity: { type: "sku", external_id: "SKU 123" },
        metrics: [{ key: "price.usd", value: 12.34, unit: "usd" }],
      }).entity.external_id,
    ).toBe("SKU 123");
    expect(() =>
      parseGenericSourceEventBody({
        event_type: "unknown.event",
        occurred_at: "2026-08-16T00:00:00.000Z",
        idempotency_key: "src:price:sku_123:2026-08-16T00:00:00Z",
        entity: { type: "sku", external_id: "SKU 123" },
      }),
    ).toThrow(/Unknown event type/);
  });

  it("normalizes identifiers deterministically and rejects confidence bounds", () => {
    expect(normalizeIdentifierValue("  SKU  123 ")).toBe("sku 123");
    expect(parseEntityType("sku")).toBe("sku");
    expect(
      canonicalEntityKey({
        entityType: "sku",
        sourceNamespace: "ingest",
        identifierType: "sku",
        normalizedValue: "sku 123",
      }),
    ).toBe("sku:ingest:sku:sku 123");
    expect(() => parseConfidence(-0.01)).toThrow();
    expect(() => parseConfidence(1.01)).toThrow();
    expect(parseConfidence(0)).toBe(0);
    expect(parseConfidence(1)).toBe(1);
    expect(isValidMetricKey("NOT_VALID")).toBe(false);
    expect(isValidMetricKey("price.usd")).toBe(true);
  });
});
