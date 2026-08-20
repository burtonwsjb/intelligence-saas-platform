import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { isProtectedPath } from "./protected-paths";
import { proxy } from "../proxy";
import {
  parseOrganizationName,
  slugifyOrganizationName,
} from "./organization-input";

describe("protected paths", () => {
  it("protects /app and onboarding", () => {
    expect(isProtectedPath("/app")).toBe(true);
    expect(isProtectedPath("/app/keys")).toBe(true);
    expect(isProtectedPath("/app/billing")).toBe(true);
    expect(isProtectedPath("/app/settings")).toBe(true);
    expect(isProtectedPath("/onboarding")).toBe(true);
    expect(isProtectedPath("/login")).toBe(false);
    expect(isProtectedPath("/admin")).toBe(true);
    expect(isProtectedPath("/admin/customers")).toBe(true);
  });
});

describe("proxy", () => {
  it("rejects unauthenticated access to /app", () => {
    const response = proxy(new NextRequest("http://localhost:3000/app"));
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    expect(response.headers.get("location")).toContain("/login");
  });

  it("lets public routes through without a session cookie", () => {
    const response = proxy(new NextRequest("http://localhost:3000/login"));
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("organization input", () => {
  it("validates and slugifies names used for initial tenant creation", () => {
    expect(parseOrganizationName("  Acme Intelligence  ")).toBe("Acme Intelligence");
    expect(parseOrganizationName("x")).toBeNull();
    expect(slugifyOrganizationName("Acme Intelligence")).toBe("acme-intelligence");
  });
});
