/**
 * Lists a TikTok creator's public videos through ScrapeCreators
 * (PROVIDER_TIKTOK_MODE=live with SCRAPECREATORS_API_KEY). TikTok's own API
 * only lists videos of people who sign in to the app, so a paid listing
 * service is the only way to follow a creator who has not; the owner chose it
 * knowing it carries the same platform-terms caveat as the transcript
 * service. Only captions, ids and dates are read; no media is downloaded.
 *
 * Validation state: fixture-tested only. The request (GET
 * /v3/tiktok/profile/videos?handle=&sort_by=latest&max_cursor=, `x-api-key`
 * header, 1 credit per page) is from the vendor's public docs; the response
 * is TikTok's own `aweme_list` shape, parsed defensively (list or keyed
 * object, `has_more` as number or boolean, missing `create_time` falls back
 * to the time in the video id). No key, header or URL is ever logged or
 * returned in a reason.
 */
import { ProviderHttpError, createFetchTransport, type HttpResponse, type HttpTransport } from "./transport.js";

export const SCRAPECREATORS_DEFAULT_BASE_URL = "https://api.scrapecreators.com";
export const TIKTOK_LIST_TIMEOUT_MS = 30_000;
const MAX_CAPTION_CHARS = 2_200;
const MAX_VIDEOS_PER_PAGE = 100;

export type TikTokListedVideo = {
  videoId: string;
  caption: string;
  /** Upload time from the service, or null when it did not say (the caller then reads it from the id). */
  createdAt: Date | null;
  durationSeconds: number | null;
  /** Pinned to the top of the profile, so older than its position suggests. */
  pinned: boolean;
  isAd: boolean;
};

export type TikTokListPage =
  | { status: "ok"; videos: TikTokListedVideo[]; nextCursor: string | null; hasMore: boolean }
  | { status: "not_found" | "rate_limited" | "error"; reason: string };

export type TikTokVideoLister = {
  readonly provider: "scrapecreators";
  /** One HTTP request per page; the daily budget counts pages. */
  listPage(handle: string, cursor: string | null): Promise<TikTokListPage>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function positive(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

/** Videos in one ScrapeCreators / TikTok `aweme_list` payload. Pure; skips anything malformed. */
export function parseTikTokVideoPage(body: unknown): { videos: TikTokListedVideo[]; nextCursor: string | null; hasMore: boolean } | null {
  const root = asRecord(body);
  const raw = root.aweme_list ?? root.videos ?? asRecord(root.data).aweme_list;
  const items = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : null;
  if (!items) return null;
  const videos: TikTokListedVideo[] = [];
  for (const entry of items.slice(0, MAX_VIDEOS_PER_PAGE)) {
    const item = asRecord(entry);
    const id = String(item.aweme_id ?? item.id ?? "");
    if (!/^\d{15,25}$/.test(id)) continue;
    const created = positive(item.create_time);
    const video = asRecord(item.video);
    // TikTok reports duration in milliseconds under video.duration and seconds under item.duration.
    const durationMs = positive(video.duration);
    const durationS = positive(item.duration);
    videos.push({
      videoId: id,
      caption: (typeof item.desc === "string" ? item.desc : "").replace(/\s+/g, " ").trim().slice(0, MAX_CAPTION_CHARS),
      createdAt: created ? new Date(created * 1000) : null,
      durationSeconds: durationMs ? Math.round(durationMs / 1000) : durationS ? Math.round(durationS) : null,
      pinned: item.is_top === true || item.is_top === 1,
      isAd: item.is_ads === true || item.is_ad === true,
    });
  }
  const cursor = root.max_cursor ?? root.cursor;
  const nextCursor = typeof cursor === "number" || (typeof cursor === "string" && /^\d{1,25}$/.test(cursor)) ? String(cursor) : null;
  const hasMore = root.has_more === true || root.has_more === 1 || root.has_more === "1";
  return { videos, nextCursor: nextCursor && nextCursor !== "0" ? nextCursor : null, hasMore };
}

export class ScrapeCreatorsTikTokLister implements TikTokVideoLister {
  readonly provider = "scrapecreators" as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly transport: HttpTransport;

  constructor(input: { apiKey: string; baseUrl?: string; transport?: HttpTransport }) {
    this.apiKey = input.apiKey;
    this.baseUrl = (input.baseUrl ?? SCRAPECREATORS_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.transport = input.transport ?? createFetchTransport({ timeoutMs: TIKTOK_LIST_TIMEOUT_MS });
  }

  async listPage(handle: string, cursor: string | null): Promise<TikTokListPage> {
    if (!/^[a-z0-9._]{2,24}$/.test(handle)) return { status: "error", reason: "invalid_handle" };
    const params = new URLSearchParams({ handle, sort_by: "latest", trim: "true" });
    if (cursor) params.set("max_cursor", cursor);
    let response: HttpResponse;
    try {
      response = await this.transport.fetch(`${this.baseUrl}/v3/tiktok/profile/videos?${params}`, {
        headers: { "x-api-key": this.apiKey, accept: "application/json" },
      });
    } catch (error) {
      return { status: "error", reason: error instanceof ProviderHttpError ? error.errorClass : "transport_failed" };
    }
    if (response.status === 404) return { status: "not_found", reason: "no_such_profile" };
    if (response.status === 429) return { status: "rate_limited", reason: "rate_limited" };
    if (response.status === 401 || response.status === 403) return { status: "error", reason: "auth" };
    if (response.status === 402) return { status: "rate_limited", reason: "out_of_credits" };
    if (response.status !== 200) return { status: "error", reason: `http_${response.status}` };
    const page = parseTikTokVideoPage(safeJson(response.bodyText));
    if (!page) return { status: "error", reason: "invalid_payload" };
    return { status: "ok", ...page };
  }
}

/** The configured lister, or null when SCRAPECREATORS_API_KEY is missing. The caller checks PROVIDER_TIKTOK_MODE. */
export function createTikTokVideoListerFromEnv(env: NodeJS.ProcessEnv, transport?: HttpTransport): TikTokVideoLister | null {
  const apiKey = env.SCRAPECREATORS_API_KEY?.trim();
  if (!apiKey) return null;
  return new ScrapeCreatorsTikTokLister({ apiKey, transport });
}
