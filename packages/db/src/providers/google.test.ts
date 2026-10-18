import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../client.js";
import { readMigrationSql } from "../migrations.js";
import { listDiscoveredCreators, runSocialDiscovery } from "./discovery.js";
import { normalizeGoogleResult } from "./live-google.js";
import type { HttpResponse } from "./transport.js";

const env = { ISP_ENV: "test", PROVIDER_GOOGLE_MODE: "live", GOOGLE_SEARCH_API_KEY: "unit-test-secret", GOOGLE_SEARCH_ENGINE_ID: "cx-test" };
const ok = (json: unknown): HttpResponse => ({ status: 200, headers: {}, bodyText: JSON.stringify(json) });
const now = new Date("2026-06-01T00:00:00Z");

describe("Google web search source", () => {
  it("keeps https pages from independent sites and skips platforms and stores", () => {
    const page = (link: string) => normalizeGoogleResult({ link, title: "Bitcoin outlook" }, { query: "bitcoin", now });
    expect(page("https://www.reddit.com/r/bitcoin/x")).toBeNull();
    expect(page("https://m.youtube.com/watch?v=1")).toBeNull();
    expect(page("https://www.ebay.com/itm/1")).toBeNull();
    expect(page("http://blog.example.com/post")).toBeNull();
    expect(page("not a url")).toBeNull();
    const row = page("https://www.Example.com/post#comments")!;
    expect(row.account.external_account_id).toBe("example.com");
    expect(row.content.canonical_url).toBe("https://www.example.com/post");
    expect(row.content.external_content_id).toHaveLength(32);
    expect(row.mentions).toEqual([{ raw_entity_text: "Bitcoin outlook", mention_context: "other" }]);
  });

  it("dates a page from its metadata only when that date is not in the future", () => {
    const at = (published: string) =>
      normalizeGoogleResult(
        { link: "https://example.com/a", pagemap: { metatags: [{ "article:published_time": published }] } },
        { query: "bitcoin", now },
      )!.content;
    expect(at("2026-05-20T10:00:00Z")).toMatchObject({ published_at: "2026-05-20T10:00:00.000Z" });
    expect(at("2026-05-20T10:00:00Z").metadata).toMatchObject({ published_at_source: "page_metadata" });
    expect(at("2027-01-01T00:00:00Z").published_at).toBe(now.toISOString());
    expect(at("garbage").metadata).toMatchObject({ published_at_source: "observed" });
  });

  describe("discovery", () => {
    let client: PGlite;
    let db: Database;
    beforeAll(async () => {
      client = new PGlite();
      await client.exec(await readMigrationSql());
      db = drizzle(client) as unknown as Database;
    }, 30_000);
    afterAll(async () => {
      await client?.close();
    });

    it("finds one creator per website, makes one counted search request and never leaks the key", async () => {
      const urls: string[] = [];
      const transport = {
        fetch: vi.fn(async (url: string) => {
          urls.push(url);
          return ok({
            items: [
              { link: "https://coindesk-like.example/btc-to-150k", title: "Bitcoin will go up to $150k", snippet: "Buy now." },
              { link: "https://coindesk-like.example/eth", title: "Ethereum notes" },
              { link: "https://analyst.example.org/bitcoin", title: "Bitcoin is overpriced" },
              { link: "https://www.reddit.com/r/bitcoin/1", title: "skip me" },
            ],
          });
        }),
      };
      const report = await runSocialDiscovery(db, { providerKey: "google", query: "Bitcoin", env, transport });
      expect(transport.fetch).toHaveBeenCalledTimes(1);
      expect(urls[0]).toContain("https://www.googleapis.com/customsearch/v1?");
      expect(urls[0]).toContain("dateRestrict=m1");
      expect(JSON.stringify(report)).not.toContain(env.GOOGLE_SEARCH_API_KEY);
      const creators = (await listDiscoveredCreators(db)).filter((row) => row.providerKey === "google");
      expect(creators.map((row) => row.externalAccountId).sort()).toEqual(["analyst.example.org", "coindesk-like.example"]);
      const budget = await client.query<{ bucket: string; requests_used: number }>(
        "SELECT bucket, requests_used FROM discovery_request_budget WHERE provider_key = 'google'",
      );
      expect(budget.rows).toEqual([{ bucket: "search", requests_used: 1 }]);
    });

    it("makes no request when switched off or outside live mode", async () => {
      const transport = { fetch: vi.fn(async () => ok({ items: [] })) };
      const keys = { GOOGLE_SEARCH_API_KEY: "k", GOOGLE_SEARCH_ENGINE_ID: "cx" };
      await expect(
        runSocialDiscovery(db, { providerKey: "google", query: "Bitcoin", env: { ISP_ENV: "test", PROVIDER_GOOGLE_MODE: "disabled", ...keys }, transport }),
      ).rejects.toThrow(/disabled/);
      const fixture = await runSocialDiscovery(db, { providerKey: "google", query: "Bitcoin", env: { ISP_ENV: "test", ...keys }, transport });
      expect(fixture.channels_seen).toBe(0);
      expect(transport.fetch).not.toHaveBeenCalled();
    });
  });
});
