import { describe, expect, it } from "vitest";
import { isDiscoverySchemaUnavailable } from "./discovery-schema";

describe("discovery schema readiness", () => {
  it("recognizes missing tables or columns through a database wrapper", () => {
    expect(isDiscoverySchemaUnavailable({ code: "42P01" })).toBe(true);
    expect(isDiscoverySchemaUnavailable(new Error("query failed", { cause: { code: "42703" } }))).toBe(true);
  });
  it("does not hide permission, authentication, or connection errors", () => {
    for (const code of ["42501", "28P01", "ECONNRESET", "57014"]) {
      expect(isDiscoverySchemaUnavailable({ code })).toBe(false);
    }
    expect(isDiscoverySchemaUnavailable(null)).toBe(false);
    expect(isDiscoverySchemaUnavailable("42P01")).toBe(false);
  });
  it("bounds cyclic causes and does not inspect potentially sensitive messages", () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(isDiscoverySchemaUnavailable(cyclic)).toBe(false);
    const error = { code: "42P01", get message(): string { throw new Error("message must not be read"); } };
    expect(isDiscoverySchemaUnavailable(error)).toBe(true);
  });
});
