import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { canonicalRedirectUrl, normalizeHost } from "./canonical-host.js";
import { proxy } from "../proxy";

describe("canonicalRedirectUrl", () => {
  it("sends www.tcgsentiment.com to the bare domain, keeping path and query", () => {
    expect(canonicalRedirectUrl("WWW.TCGSentiment.com:443", "/app/cards/x", "?tab=chart")).toBe(
      "https://tcgsentiment.com/app/cards/x?tab=chart",
    );
    expect(canonicalRedirectUrl("www.tcgsentiment.com", "/login", "")).toBe("https://tcgsentiment.com/login");
  });

  it("leaves the apex, the socialsignaliq.com engine, Railway, staging and local hosts alone", () => {
    expect(canonicalRedirectUrl("socialsignaliq.com", "/", "")).toBeNull();
    expect(canonicalRedirectUrl("api.socialsignaliq.com", "/", "")).toBeNull();
    expect(canonicalRedirectUrl("tcgsentiment.com", "/", "")).toBeNull();
    expect(canonicalRedirectUrl("isp-staging-web-production.up.railway.app", "/", "")).toBeNull();
    expect(canonicalRedirectUrl("localhost:3000", "/", "")).toBeNull();
    expect(canonicalRedirectUrl(null, "/", "")).toBeNull();
  });

  it("never builds a protocol-relative path", () => {
    expect(canonicalRedirectUrl("www.tcgsentiment.com", "//evil.example", "")).toBe("https://tcgsentiment.com/");
  });

  it("normalizes forwarded host lists and trailing dots", () => {
    expect(normalizeHost("www.tcgsentiment.com., proxy.internal")).toBe("www.tcgsentiment.com");
  });
});

describe("proxy host redirect", () => {
  it("308s a www request before any auth check", () => {
    const response = proxy(
      new NextRequest("https://www.tcgsentiment.com/app?x=1", { headers: { host: "www.tcgsentiment.com" } }),
    );
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://tcgsentiment.com/app?x=1");
  });

  it("serves tcgsentiment.com normally", () => {
    const response = proxy(new NextRequest("https://tcgsentiment.com/", { headers: { host: "tcgsentiment.com" } }));
    expect(response.headers.get("location")).toBeNull();
  });
});
