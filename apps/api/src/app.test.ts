import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createApiApp } from "./app.js";
import { requireScope, type MachinePrincipal } from "./machine-auth.js";
import type { Database } from "@isp/db";

const dummyDb = {
  execute: async () => [],
} as unknown as Database;

describe("GET /health", () => {
  it("returns the shared health contract and stays unauthenticated", async () => {
    const app = createApiApp();
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});

describe("machine auth", () => {
  it("rejects missing and invalid bearer tokens without leaking secrets", async () => {
    const app = createApiApp({
      db: dummyDb,
      env: { API_KEY_PEPPER: "phase04-test-pepper-value" },
    });
    const missing = await app.request("/v1/me");
    expect(missing.status).toBe(401);
    const invalid = await app.request("/v1/me", {
      headers: { authorization: "Bearer isp_test_deadbeef_not-a-real-secret" },
    });
    expect(invalid.status).toBe(401);
    const body = await invalid.text();
    expect(body).not.toMatch(/isp_test_deadbeef_not-a-real-secret/);
  });
});

describe("Stripe webhook", () => {
  it("rejects an invalid signature", async () => {
    const app = createApiApp({
      db: dummyDb,
      env: { STRIPE_WEBHOOK_SECRET: "whsec_test_phase04" },
    });
    const response = await app.request("/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": "invalid" },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });
});

describe("API scopes", () => {
  it("returns 403 when the required scope is missing", async () => {
    const app = new Hono<{ Variables: { machine: MachinePrincipal } }>();
    app.use("/v1/*", async (c, next) => {
      c.set("machine", {
        organizationId: "org_a",
        apiKeyId: "key_a",
        scopes: ["ingest:write"],
      });
      await next();
    });
    app.get("/v1/me", requireScope("decisions:read"), (c) => c.json({ ok: true }));
    const response = await app.request("/v1/me?organization_id=org_b");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "scope_denied" },
    });
  });
});
