import { createHash } from "node:crypto";
import type { SourceContentRecordInput } from "../source/identity.js";
import { SOURCE_NORMALIZER_VERSION } from "./catalog.js";
import { createFetchTransport, requireOkJson, ProviderHttpError, type HttpTransport } from "./transport.js";

export const GOOGLE_SEARCH_ENDPOINT = "https://www.googleapis.com/customsearch/v1";

/**
 * Sites never treated as creators from web search: platforms collected through
 * their own providers, and marketplaces and stores, which sell rather than
 * make calls.
 */
export const GOOGLE_SKIPPED_DOMAINS = [
  "youtube.com",
  "youtu.be",
  "reddit.com",
  "x.com",
  "twitter.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "pinterest.com",
  "amazon.com",
  "ebay.com",
  "tcgplayer.com",
  "walmart.com",
  "target.com",
  "bestbuy.com",
  "pokemoncenter.com",
  "cardmarket.com",
] as const;

export function siteDomain(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

function skipped(domain: string): boolean {
  return GOOGLE_SKIPPED_DOMAINS.some((root) => domain === root || domain.endsWith(`.${root}`));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const PUBLISHED_META_KEYS = ["article:published_time", "og:article:published_time", "datepublished", "date", "pubdate"];

/**
 * Publication time from the page's metadata when it is a valid date no later
 * than now; otherwise the time it was found. The found time can only be later
 * than the real publication, so a call is never priced before it was made.
 */
function publishedAt(item: Record<string, unknown>, now: Date): { at: string; source: "page_metadata" | "observed" } {
  const metatags = asRecord(item.pagemap).metatags;
  const tags = asRecord(Array.isArray(metatags) ? metatags[0] : metatags);
  for (const key of PUBLISHED_META_KEYS) {
    const raw = asString(tags[key]);
    const time = raw ? Date.parse(raw) : Number.NaN;
    if (Number.isFinite(time) && time <= now.getTime() && time > Date.parse("2000-01-01T00:00:00Z")) {
      return { at: new Date(time).toISOString(), source: "page_metadata" };
    }
  }
  return { at: now.toISOString(), source: "observed" };
}

/** One search result as a source record, or null when it is not https or its site is skipped. */
export function normalizeGoogleResult(raw: unknown, input: { query: string; now?: Date }): SourceContentRecordInput | null {
  const item = asRecord(raw);
  const link = asString(item.link);
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const domain = siteDomain(url.hostname);
  if (!domain || skipped(domain)) return null;
  url.hash = "";
  const canonical = url.toString();
  const id = createHash("sha256").update(canonical).digest("hex").slice(0, 32);
  const title = asString(item.title) ?? null;
  const snippet = asString(item.snippet)?.replace(/\s+/g, " ").slice(0, 500) ?? null;
  const published = publishedAt(item, input.now ?? new Date());
  return {
    provider: "web",
    provider_record_id: `google:${id}`,
    event_type: "source.content.ingested",
    account: {
      external_account_id: domain,
      handle: domain,
      display_name: asString(item.displayLink) ? siteDomain(asString(item.displayLink)!) : domain,
      canonical_url: `https://${domain}`,
      metadata: { kind: "website" },
    },
    content: {
      external_content_id: id,
      content_type: "article",
      published_at: published.at,
      title,
      summary: snippet,
      canonical_url: canonical,
      language: null,
      license_status: "reference_only",
      retention_policy: "reference_only",
      transcript_available: false,
      excerpt: null,
      metadata: {
        normalizer_version: SOURCE_NORMALIZER_VERSION,
        search_provider: "google",
        search_query: input.query,
        published_at_source: published.source,
      },
    },
    mentions: title ? [{ raw_entity_text: title, mention_context: "other" }] : undefined,
  };
}

/** Google Programmable Search JSON API. Every call is one search request. */
export class LiveGoogleSearchProvider {
  constructor(
    private readonly auth: { apiKey: string; engineId: string },
    private readonly transport: HttpTransport = createFetchTransport(),
  ) {}

  private async search(params: Record<string, string>, query: string, limit: number) {
    const search = new URLSearchParams({
      key: this.auth.apiKey,
      cx: this.auth.engineId,
      num: String(Math.max(1, Math.min(10, limit))),
      safe: "active",
      ...params,
    });
    const response = await this.transport.fetch(`${GOOGLE_SEARCH_ENDPOINT}?${search.toString()}`, {
      headers: { accept: "application/json" },
    });
    const json = requireOkJson(response, (value) => value as { items?: unknown[] });
    const now = new Date();
    return (Array.isArray(json.items) ? json.items : [])
      .map((item) => normalizeGoogleResult(item, { query, now }))
      .filter((row): row is SourceContentRecordInput => row != null)
      .slice(0, limit);
  }

  /** Recent web pages about a topic. */
  async searchWeb(query: { q: string; limit?: number }) {
    const q = query.q.trim();
    if (!q) return [];
    // Past month, newest first, so discovery finds current voices.
    return this.search({ q, dateRestrict: "m1", sort: "date" }, q, query.limit ?? 10);
  }

  /** Recent pages from one website about the topic it was found under. */
  async getRecentSiteContent(domain: string, topic: string, limit = 10) {
    const site = siteDomain(domain);
    if (!/^[a-z0-9.-]{3,253}$/.test(site) || !site.includes(".")) {
      throw new ProviderHttpError({ status: 0, errorClass: "invalid_account" });
    }
    const rows = await this.search(
      { q: topic.trim() || "price", siteSearch: site, siteSearchFilter: "i", dateRestrict: "m1", sort: "date" },
      topic,
      limit,
    );
    return rows.filter((row) => row.account.external_account_id === site);
  }
}

export function createLiveGoogleProvider(env: NodeJS.ProcessEnv, transport?: HttpTransport) {
  const apiKey = env.GOOGLE_SEARCH_API_KEY?.trim();
  const engineId = env.GOOGLE_SEARCH_ENGINE_ID?.trim();
  if (!apiKey || !engineId) return null;
  return new LiveGoogleSearchProvider({ apiKey, engineId }, transport);
}
