import { describe, expect, it } from "vitest";
import { safeInternalPath, securityHeaders } from "./security-headers.js";

describe("securityHeaders", () => {
  it("sets frame denial, nosniff, CSP, and HSTS only when hosted", () => {
    const local = Object.fromEntries(securityHeaders().map((row) => [row.key, row.value]));
    expect(local["X-Frame-Options"]).toBe("DENY");
    expect(local["X-Content-Type-Options"]).toBe("nosniff");
    expect(local["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(local["Content-Security-Policy"]).toContain("object-src 'none'");
    expect(local["Strict-Transport-Security"]).toBeUndefined();
    expect(
      securityHeaders({ hosted: true }).some((row) => row.key === "Strict-Transport-Security"),
    ).toBe(true);
  });
});

describe("safeInternalPath", () => {
  it("rejects open redirects and protocol-relative URLs", () => {
    expect(safeInternalPath("/app/keys")).toBe("/app/keys");
    expect(safeInternalPath("//evil.example/phish")).toBeNull();
    expect(safeInternalPath("https://evil.example")).toBeNull();
    expect(safeInternalPath("/\\evil")).toBeNull();
    expect(safeInternalPath("app")).toBeNull();
  });
});
