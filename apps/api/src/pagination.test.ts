import { describe, expect, it } from "vitest";
import { CommercialFilterError, encodeCursor, pageEnvelope, parseCommercialQuery } from "./pagination.js";
import { commercialOpenApi } from "./openapi.js";

describe("commercial filters and OpenAPI", () => {
  it("rejects unknown filters and preserves cursor pagination", () => {
    expect(() => parseCommercialQuery({ sql: "1" })).toThrow(CommercialFilterError);
    expect(parseCommercialQuery({ language: "ja", limit: "2" }).language).toBe("ja");
    expect(encodeCursor("prn_1").length).toBeGreaterThan(0);
    expect(commercialOpenApi().paths["/webhooks/stripe"]).toBeUndefined();
    expect(() => parseCommercialQuery({ sort: "price" })).toThrow(CommercialFilterError);
    expect(parseCommercialQuery({ sort: "id" }).sort).toBe("id");
    expect(
      pageEnvelope({ data: [{ id: "a" }], nextCursor: "n", limit: 20, requestId: "req_1" }),
    ).toMatchObject({ has_more: true, limit: 20, request_id: "req_1" });
  });
});
