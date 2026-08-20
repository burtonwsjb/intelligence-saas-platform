import { describe, expect, it } from "vitest";
import { createApiApp } from "./app.js";
import type { Database } from "@isp/db";

const dummyDb = {
  execute: async () => [{ ok: 1 }],
} as unknown as Database;

describe("load smoke", () => {
  it("serves a bounded /health burst without errors", async () => {
    const app = createApiApp();
    const samples: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      const started = Date.now();
      const response = await app.request("/health");
      samples.push(Date.now() - started);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: "ok" });
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(Math.max(...samples)).toBeLessThan(2_000);
  });

  it("reports readiness from a database ping without leaking credentials", async () => {
    const app = createApiApp({ db: dummyDb, env: { APP_URL: "https://app.example.invalid" } });
    const response = await app.request("/ready", {
      headers: { origin: "https://app.example.invalid" },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: "ready", database: "ok", redis: "skipped" });
    expect(JSON.stringify(body)).not.toMatch(/postgres|redis:\/\//);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example.invalid");
  });
});
