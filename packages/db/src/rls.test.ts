import { describe, expect, it } from "vitest";
import { InvalidTenantContextError } from "./errors.js";
import { parseOrganizationContext } from "./rls.js";

describe("tenant context parsing", () => {
  it("accepts safe identifiers", () => {
    expect(
      parseOrganizationContext({
        organizationId: "org_123",
        userId: "user-1",
      }),
    ).toEqual({ organizationId: "org_123", userId: "user-1" });
  });

  it("rejects values that could broaden or inject context", () => {
    expect(() =>
      parseOrganizationContext({ organizationId: "", userId: "user-1" }),
    ).toThrow(InvalidTenantContextError);
    expect(() =>
      parseOrganizationContext({ organizationId: "org a", userId: "user-1" }),
    ).toThrow(InvalidTenantContextError);
    expect(() =>
      parseOrganizationContext({
        organizationId: "org'; select 1 --",
        userId: "user-1",
      }),
    ).toThrow(InvalidTenantContextError);
  });
});
