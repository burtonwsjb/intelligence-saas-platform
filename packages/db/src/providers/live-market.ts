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
    return { ok: true as const, mode: "sandbox_fixture" as const };
  }

  async liveHealth(): Promise<{ ok: boolean; remaining: number | null; resetAt: Date | null }> {
    const url = `${this.auth.baseUrl.replace(/\/$/, "")}/v1/health`;
    const response = await this.transport.fetch(url, { headers: this.headers() });
    const rate = parseRateLimitHeaders(response.headers);
    return { ok: response.status < 500, remaining: rate.remaining, resetAt: rate.resetAt };
  }

  async getMarketSnapshots(query: { printingExternalId?: string; language?: string; limit?: number }) {
    const params = new URLSearchParams();
    if (query.printingExternalId) {
      params.set("printing_id", query.printingExternalId);
    }
    if (query.language) {
      params.set("language", query.language);
    }
    params.set("limit", String(Math.min(query.limit ?? 25, 50)));
    return this.get(`/v1/market/snapshots?${params.toString()}`);
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
