import { describe, expect, it } from "vitest";
import {
  INGEST_MAX_BYTES,
  IngestPayloadTooLargeError,
  IngestValidationError,
  fingerprintIngest,
  parseIngestBody,
} from "./ingest.js";

const valid = {
  event_type: "pricing.snapshot",
  occurred_at: "2026-08-16T00:00:00.000Z",
  idempotency_key: "src:price:sku_123:2026-08-16T00:00:00Z",
  entity: { type: "sku", external_id: "sku_123" },
  metrics: [{ key: "price.usd", value: 12.34, unit: "usd" }],
  payload: { source: "generic_http" },
};

describe("ingest validation", () => {
  it("accepts the contract shape and fingerprints stably", () => {
    const body = parseIngestBody(JSON.stringify(valid));
    expect(body.event_type).toBe("pricing.snapshot");
    expect(fingerprintIngest(body)).toBe(fingerprintIngest(body));
  });

  it("rejects oversize and unknown/invalid event types", () => {
    expect(() => parseIngestBody("not-json")).toThrow(IngestValidationError);
    expect(() =>
      parseIngestBody(JSON.stringify({ ...valid, event_type: "NOT_VALID" })),
    ).toThrow(IngestValidationError);
    expect(() => parseIngestBody("x".repeat(INGEST_MAX_BYTES + 1))).toThrow(
      IngestPayloadTooLargeError,
    );
  });
});
