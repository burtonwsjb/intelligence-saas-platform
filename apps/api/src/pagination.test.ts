import { describe, expect, it } from "vitest";
import { CommercialFilterError, encodeCursor, parseCommercialQuery } from "./pagination.js";
import { commercialOpenApi } from "./openapi.js";

describe("commercial filters and OpenAPI", () => {
  it("rejects unknown filters and preserves cursor pagination", () => {
    expect(() => parseCommercialQuery({ sql: "1" })).toThrow(CommercialFilterError);
    expect(parseCommercialQuery({ language: "ja", limit: "2" }).language).toBe("ja");
    expect(encodeCursor("prn_1").length).toBeGreaterThan(0);
    expect(commercialOpenApi().paths["/webhooks/stripe"]).toBeUndefined();
  });
});
