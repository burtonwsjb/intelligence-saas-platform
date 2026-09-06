import type { TcgMarketRecordInput } from "../tcg/market-identity.js";
import type { TcgMarketProvider } from "../tcg/market-provider.js";
import { normalizeMarketVendorList } from "./market-normalize.js";
import {
  createFetchTransport,
  parseRateLimitHeaders,
  requireOkJson,
  type HttpTransport,
} from "./transport.js";

export type LiveMarketAuth = {
  baseUrl: string;
  token?: string;
  publicKey?: string;
  privateKey?: string;
};

export class LiveTcgMarketProvider implements TcgMarketProvider {
  readonly provider: "tcg_card_central" | "tcgplayer" | "ebay";
  private readonly transport: HttpTransport;
  private readonly auth: LiveMarketAuth;

  constructor(input: {
    provider: "tcg_card_central" | "tcgplayer" | "ebay";
    auth: LiveMarketAuth;
    transport?: HttpTransport;
  }) {
    this.provider = input.provider;
    this.auth = input.auth;
    this.transport = input.transport ?? createFetchTransport();
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.auth.token) {
      headers.authorization = `Bearer ${this.auth.token}`;
    }
    if (this.auth.publicKey) {
      headers["x-public-key"] = this.auth.publicKey;
    }
    if (this.auth.privateKey) {
      headers["x-private-key"] = this.auth.privateKey;
    }
    return headers;
  }

  private async get(path: string): Promise<TcgMarketRecordInput[]> {
    const url = `${this.auth.baseUrl.replace(/\/$/, "")}${path}`;
    const response = await this.transport.fetch(url, { headers: this.headers() });
    const records = requireOkJson(response, (value) => normalizeMarketVendorList(this.provider, value));
    void parseRateLimitHeaders(response.headers);
    return records;
  }

  async healthCheck() {
    return { ok: true as const, mode: "live" as const };
  }

  async liveHealth(): Promise<{ ok: boolean; remaining: number | null; resetAt: Date | null }> {
    const url = `${this.auth.baseUrl.replace(/\/$/, "")}/v1/health`;
    const response = await this.transport.fetch(url, { headers: this.headers() });
    const rate = parseRateLimitHeaders(response.headers);
    return { ok: response.status < 500, remaining: rate.remaining, resetAt: rate.resetAt };
  }

  private nativeHost(): boolean {
    const host = this.auth.baseUrl.replace(/\/$/, "");
    if (this.provider === "tcgplayer") {
      return host.includes("api.tcgplayer.com");
    }
    if (this.provider === "ebay") {
      return host.includes("api.ebay.com");
    }
    return false;
  }

  private async tcgplayerToken(): Promise<string> {
    if (this.auth.token) {
      return this.auth.token;
    }
    const response = await this.transport.fetch(`${this.auth.baseUrl.replace(/\/$/, "")}/token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=client_credentials&client_id=${encodeURIComponent(this.auth.publicKey ?? "")}&client_secret=${encodeURIComponent(this.auth.privateKey ?? "")}`,
    });
    const json = requireOkJson(response, (value) => value as { access_token?: string });
    if (!json.access_token) {
      throw new Error("TCGplayer access token missing.");
    }
    this.auth.token = json.access_token;
    return this.auth.token;
  }

  private async getNative(path: string, headers: Record<string, string>): Promise<TcgMarketRecordInput[]> {
    const url = `${this.auth.baseUrl.replace(/\/$/, "")}${path}`;
    const response = await this.transport.fetch(url, { headers });
    void parseRateLimitHeaders(response.headers);
    return requireOkJson(response, (value) => normalizeMarketVendorList(this.provider, value));
  }

  async getMarketSnapshots(query: { printingExternalId?: string; language?: string; limit?: number; q?: string }) {
    const limit = Math.min(query.limit ?? 25, 50);
    if (this.provider === "tcgplayer" && this.nativeHost()) {
      const ids = (query.printingExternalId ?? process.env.TCGPLAYER_PRODUCT_IDS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 10);
      if (ids.length === 0) {
        return [];
      }
      const token = await this.tcgplayerToken();
      return this.getNative(`/pricing/product/${ids.join(",")}`, {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      });
    }
    if (this.provider === "ebay" && this.nativeHost()) {
      const q = (query.q ?? query.printingExternalId ?? process.env.EBAY_SEARCH_QUERY ?? "Pokemon TCG").trim();
      const token = this.auth.token;
      if (!token) {
        return [];
      }
      return this.getNative(`/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&limit=${Math.min(limit, 10)}`, {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "x-ebay-c-marketplace-id": "EBAY_US",
      });
    }
    const params = new URLSearchParams();
    if (query.printingExternalId) {
      params.set("printing_id", query.printingExternalId);
    }
    if (query.language) {
      params.set("language", query.language);
    }
    params.set("limit", String(limit));
    const first = await this.get(`/v1/market/snapshots?${params.toString()}`);
    if (first.length < limit) {
      return first;
    }
    params.set("page", "2");
    const second = await this.get(`/v1/market/snapshots?${params.toString()}`);
    return [...first, ...second].slice(0, limit);
  }

  async getSoldTransactions(query: { printingExternalId?: string; language?: string; limit?: number }) {
    const rows = await this.getMarketSnapshots(query);
    return rows.filter((row) => row.market_type === "marketplace_sold");
  }

  async getListingSnapshot(query: { printingExternalId?: string; language?: string }) {
    const rows = await this.getMarketSnapshots(query);
    return rows.find((row) => row.market_type === "marketplace_listing") ?? null;
  }
}

export function createLiveMarketProvider(
  provider: "tcg_card_central" | "tcgplayer" | "ebay",
  env: NodeJS.ProcessEnv = process.env,
  transport?: HttpTransport,
): LiveTcgMarketProvider | null {
  if (provider === "tcg_card_central") {
    const baseUrl = env.TCC_API_BASE_URL?.trim();
    const token = env.TCC_API_TOKEN?.trim();
    if (!baseUrl || !token) {
      return null;
    }
    return new LiveTcgMarketProvider({ provider, auth: { baseUrl, token }, transport });
  }
  if (provider === "tcgplayer") {
    const baseUrl = env.TCGPLAYER_API_BASE_URL?.trim() || "https://api.tcgplayer.com";
    const publicKey = env.TCGPLAYER_PUBLIC_KEY?.trim();
    const privateKey = env.TCGPLAYER_PRIVATE_KEY?.trim();
    if (!publicKey || !privateKey) {
      return null;
    }
    return new LiveTcgMarketProvider({ provider, auth: { baseUrl, publicKey, privateKey }, transport });
  }
  const baseUrl = env.EBAY_API_BASE_URL?.trim() || "https://api.ebay.com";
  const token = env.EBAY_OAUTH_TOKEN?.trim();
  if (!token) {
    return null;
  }
  return new LiveTcgMarketProvider({ provider: "ebay", auth: { baseUrl, token }, transport });
}
