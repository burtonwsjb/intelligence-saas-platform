import type { SourceContentRecordInput } from "../source/identity.js";
import type { RedditSourceProvider, YoutubeSourceProvider } from "../source/provider.js";
import { normalizeRedditListing, normalizeYoutubeVideo } from "./source-normalize.js";
import {
  createFetchTransport,
  requireOkJson,
  ProviderHttpError,
  type HttpTransport,
} from "./transport.js";

export class LiveRedditSourceProvider implements RedditSourceProvider {
  constructor(
    private readonly auth: { clientId: string; clientSecret: string; userAgent: string; subreddits: string[] },
    private readonly transport: HttpTransport = createFetchTransport(),
    private accessToken?: string,
  ) {}

  async healthCheck() {
    return { ok: true as const, mode: "live" as const };
  }

  private async token(): Promise<string> {
    if (this.accessToken) {
      return this.accessToken;
    }
    const basic = Buffer.from(`${this.auth.clientId}:${this.auth.clientSecret}`).toString("base64");
    const response = await this.transport.fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": this.auth.userAgent,
      },
      body: "grant_type=client_credentials",
    });
    const json = requireOkJson(response, (value) => value as { access_token?: string });
    if (!json.access_token) {
      throw new Error("Reddit access token missing.");
    }
    this.accessToken = json.access_token;
    return this.accessToken;
  }

  private async listing(path: string): Promise<SourceContentRecordInput[]> {
    const token = await this.token();
    const response = await this.transport.fetch(`https://oauth.reddit.com${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        "user-agent": this.auth.userAgent,
        accept: "application/json",
      },
    });
    const json = requireOkJson(response, (value) => value as { data?: { children?: Array<{ data: unknown }> } });
    return (json.data?.children ?? []).map((child) => normalizeRedditListing(child));
  }

  async searchCommunities(query: { q: string; limit?: number }) {
    const limit = Math.min(query.limit ?? 5, 10);
    const q = encodeURIComponent(query.q.trim());
    const token = await this.token();
    const response = await this.transport.fetch(
      `https://oauth.reddit.com/subreddits/search?q=${q}&limit=${limit}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          "user-agent": this.auth.userAgent,
          accept: "application/json",
        },
      },
    );
    const json = requireOkJson(response, (value) => value as { data?: { children?: Array<{ data: Record<string, unknown> }> } });
    return (json.data?.children ?? [])
      .map((child) => {
        const name = typeof child.data.display_name === "string" ? child.data.display_name : "";
        const subscribers = typeof child.data.subscribers === "number" ? child.data.subscribers : null;
        return name
          ? {
              name,
              subscribers,
              title: typeof child.data.title === "string" ? child.data.title : name,
            }
          : null;
      })
      .filter((row): row is { name: string; subscribers: number | null; title: string } => Boolean(row));
  }

  async searchPosts(query: { language?: string; limit?: number; q?: string }) {
    const limit = Math.min(query.limit ?? 10, 25);
    if (query.q?.trim()) {
      const q = encodeURIComponent(query.q.trim());
      const rows = await this.listing(`/search?q=${q}&sort=new&limit=${limit}&type=link`);
      return rows.filter((row) => !query.language || row.content.language === query.language);
    }
    const subs = this.auth.subreddits.slice(0, 3);
    const per = Math.max(1, Math.ceil(limit / Math.max(subs.length, 1)));
    const rows: SourceContentRecordInput[] = [];
    for (const sub of subs) {
      rows.push(...(await this.listing(`/r/${encodeURIComponent(sub)}/new?limit=${per}`)));
    }
    return rows
      .filter((row) => !query.language || row.content.language === query.language)
      .slice(0, limit);
  }

  async getRecentAuthorPosts(externalAccountId: string, limit = 10) {
    const author = externalAccountId.replace(/^u\//, "");
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(author) || author === "unknown") {
      throw new ProviderHttpError({ status: 0, errorClass: "invalid_account" });
    }
    const rows = await this.listing(`/user/${encodeURIComponent(author)}/submitted?sort=new&limit=${Math.max(1, Math.min(10, limit))}`);
    return rows.filter((row) => row.account.external_account_id.replace(/^u\//, "").toLowerCase() === author.toLowerCase()).slice(0, limit);
  }

  /** One data request. Returns the account's canonical name, or null when it does not exist. */
  async getUser(username: string): Promise<{ external_account_id: string; display_name: string } | null> {
    const name = username.replace(/^u\//i, "");
    if (!/^[A-Za-z0-9_-]{3,20}$/.test(name)) {
      throw new ProviderHttpError({ status: 0, errorClass: "invalid_account" });
    }
    const token = await this.token();
    const response = await this.transport.fetch(`https://oauth.reddit.com/user/${encodeURIComponent(name)}/about`, {
      headers: { authorization: `Bearer ${token}`, "user-agent": this.auth.userAgent, accept: "application/json" },
    });
    if (response.status === 404) return null;
    const json = requireOkJson(response, (value) => value as { data?: { name?: string; is_suspended?: boolean } });
    const canonical = json.data?.name;
    if (!canonical || json.data?.is_suspended) return null;
    return { external_account_id: canonical, display_name: canonical };
  }

  async getPost(externalContentId: string) {
    const rows = await this.listing(`/by_id/t3_${externalContentId}`);
    return rows[0] ?? null;
  }

  async getSubreddit(name: string) {
    return name ? { name } : null;
  }

  async getEngagementSnapshot(externalContentId: string) {
    return (await this.getPost(externalContentId))?.engagement ?? null;
  }
}

export class LiveYoutubeSourceProvider implements YoutubeSourceProvider {
  constructor(
    private readonly auth: { apiKey: string; channelIds: string[] },
    private readonly transport: HttpTransport = createFetchTransport(),
  ) {}

  async healthCheck() {
    return { ok: true as const, mode: "live" as const };
  }

  private async videos(params: URLSearchParams): Promise<SourceContentRecordInput[]> {
    const url = `https://www.googleapis.com/youtube/v3/videos?${params.toString()}`;
    const response = await this.transport.fetch(url, { headers: { accept: "application/json", "x-goog-api-key": this.auth.apiKey } });
    const json = requireOkJson(response, (value) => value as { items?: unknown[] });
    return (json.items ?? []).map((item) => normalizeYoutubeVideo(item));
  }

  private async channelStats(channelIds: string[]) {
    const unique = [...new Set(channelIds.filter(Boolean))].slice(0, 10);
    if (unique.length === 0) {
      return new Map<string, { subscribers: number | null; views: number | null; title: string | null }>();
    }
    const params = new URLSearchParams({
      part: "snippet,statistics",
      id: unique.join(","),
    });
    const response = await this.transport.fetch(
      `https://www.googleapis.com/youtube/v3/channels?${params.toString()}`,
      { headers: { accept: "application/json", "x-goog-api-key": this.auth.apiKey } },
    );
    const json = requireOkJson(
      response,
      (value) =>
        value as {
          items?: Array<{
            id?: string;
            snippet?: { title?: string };
            statistics?: { subscriberCount?: string; viewCount?: string };
          }>;
        },
    );
    return new Map(
      (json.items ?? []).map((item) => [
        item.id ?? "",
        {
          subscribers: item.statistics?.subscriberCount ? Number(item.statistics.subscriberCount) : null,
          views: item.statistics?.viewCount ? Number(item.statistics.viewCount) : null,
          title: item.snippet?.title ?? null,
        },
      ]),
    );
  }

  private attachChannelStats(
    rows: SourceContentRecordInput[],
    stats: Map<string, { subscribers: number | null; views: number | null; title: string | null }>,
  ) {
    return rows.map((row) => {
      const channel = stats.get(row.account.external_account_id);
      if (!channel) {
        return row;
      }
      return {
        ...row,
        account: {
          ...row.account,
          display_name: channel.title ?? row.account.display_name,
          metadata: {
            ...row.account.metadata,
            subscriber_count: channel.subscribers,
            channel_view_count: channel.views,
          },
        },
      };
    });
  }

  async searchContent(query: { language?: string; limit?: number; q?: string }) {
    const search = new URLSearchParams({
      part: "snippet",
      maxResults: String(Math.min(query.limit ?? 5, 10)),
      type: "video",
    });
    if (query.q?.trim()) {
      search.set("q", query.q.trim());
      search.set("order", "relevance");
    } else if (this.auth.channelIds[0]) {
      search.set("channelId", this.auth.channelIds[0]);
      search.set("order", "date");
    } else {
      return [];
    }
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?${search.toString()}`;
    const response = await this.transport.fetch(searchUrl, { headers: { accept: "application/json", "x-goog-api-key": this.auth.apiKey } });
    const json = requireOkJson(response, (value) => value as { items?: Array<{ id?: { videoId?: string } }> });
    const ids = (json.items ?? []).map((item) => item.id?.videoId).filter((id): id is string => Boolean(id));
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.videos(
      new URLSearchParams({ part: "snippet,statistics", id: ids.join(",") }),
    );
    const stats = await this.channelStats(rows.map((row) => row.account.external_account_id));
    return this.attachChannelStats(rows, stats).filter(
      (row) => !query.language || row.content.language === query.language,
    );
  }

  /** Poll the discovered channel's uploads, not an operator-supplied channel list.
   * Three bounded data requests; no expensive search request or unbounded crawl.
   */
  async getRecentChannelContent(externalAccountId: string, limit = 10) {
    if (!/^[A-Za-z0-9_-]{3,128}$/.test(externalAccountId)) {
      throw new ProviderHttpError({ status: 0, errorClass: "invalid_account" });
    }
    const headers = { accept: "application/json", "x-goog-api-key": this.auth.apiKey };
    const channelParams = new URLSearchParams({ part: "contentDetails", id: externalAccountId });
    const response = await this.transport.fetch(`https://www.googleapis.com/youtube/v3/channels?${channelParams}`, { headers });
    const channel = requireOkJson(response, (value) => value as {
      items?: Array<{ id?: string; contentDetails?: { relatedPlaylists?: { uploads?: string } } }>;
    }).items?.find((item) => item.id === externalAccountId);
    const uploads = channel?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) throw new ProviderHttpError({ status: 404, errorClass: "channel_unavailable" });
    const params = new URLSearchParams({ part: "contentDetails", playlistId: uploads, maxResults: String(Math.max(1, Math.min(10, limit))) });
    const playlist = await this.transport.fetch(`https://www.googleapis.com/youtube/v3/playlistItems?${params}`, { headers });
    const items = requireOkJson(playlist, (value) => value as {
      items?: Array<{ contentDetails?: { videoId?: string } }>;
    }).items ?? [];
    const ids = [...new Set(items.map((item) => item.contentDetails?.videoId).filter((id): id is string => typeof id === "string" && id.length > 0))].slice(0, limit);
    if (!ids.length) return [];
    const rows = await this.videos(new URLSearchParams({ part: "snippet,statistics", id: ids.join(",") }));
    // Never attach a response for another channel to this monitored identity.
    return rows.filter((row) => row.account.external_account_id === externalAccountId).slice(0, limit);
  }

  /** The channel's uploads playlist id. One data request; null when the channel is unavailable. */
  async getUploadsPlaylistId(channelId: string): Promise<string | null> {
    if (!/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
      throw new ProviderHttpError({ status: 0, errorClass: "invalid_account" });
    }
    const params = new URLSearchParams({ part: "contentDetails", id: channelId });
    const response = await this.transport.fetch(`https://www.googleapis.com/youtube/v3/channels?${params}`, {
      headers: { accept: "application/json", "x-goog-api-key": this.auth.apiKey },
    });
    const channel = requireOkJson(response, (value) => value as {
      items?: Array<{ id?: string; contentDetails?: { relatedPlaylists?: { uploads?: string } } }>;
    }).items?.find((item) => item.id === channelId);
    const uploads = channel?.contentDetails?.relatedPlaylists?.uploads;
    return typeof uploads === "string" && /^[A-Za-z0-9_-]{10,64}$/.test(uploads) ? uploads : null;
  }

  /**
   * One page (up to 50) of an uploads playlist, newest first: video ids and
   * their publish times. One data request (playlistItems.list, 1 quota unit).
   */
  async getUploadsPage(
    playlistId: string,
    pageToken: string | null,
  ): Promise<{ items: Array<{ videoId: string; publishedAt: string | null }>; nextPageToken: string | null }> {
    if (!/^[A-Za-z0-9_-]{10,64}$/.test(playlistId) || (pageToken != null && !/^[A-Za-z0-9_-]{1,200}$/.test(pageToken))) {
      throw new ProviderHttpError({ status: 0, errorClass: "invalid_request" });
    }
    const params = new URLSearchParams({ part: "contentDetails", playlistId, maxResults: "50" });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await this.transport.fetch(`https://www.googleapis.com/youtube/v3/playlistItems?${params}`, {
      headers: { accept: "application/json", "x-goog-api-key": this.auth.apiKey },
    });
    const json = requireOkJson(response, (value) => value as {
      items?: Array<{ contentDetails?: { videoId?: string; videoPublishedAt?: string } }>;
      nextPageToken?: string;
    });
    const items = (json.items ?? [])
      .map((item) => ({
        videoId: item.contentDetails?.videoId ?? "",
        publishedAt: typeof item.contentDetails?.videoPublishedAt === "string" ? item.contentDetails.videoPublishedAt : null,
      }))
      .filter((item) => /^[A-Za-z0-9_-]{6,20}$/.test(item.videoId));
    return { items, nextPageToken: typeof json.nextPageToken === "string" && json.nextPageToken ? json.nextPageToken : null };
  }

  /**
   * Metadata of up to 50 videos (videos.list snippet+statistics, one data
   * request): the normalized record plus the full description, which the
   * caller scans for card names and never stores whole.
   */
  async getVideoDetails(ids: string[]): Promise<Array<{ record: SourceContentRecordInput; description: string }>> {
    const unique = [...new Set(ids.filter((id) => /^[A-Za-z0-9_-]{6,20}$/.test(id)))].slice(0, 50);
    if (unique.length === 0) return [];
    const params = new URLSearchParams({ part: "snippet,statistics", id: unique.join(",") });
    const response = await this.transport.fetch(`https://www.googleapis.com/youtube/v3/videos?${params}`, {
      headers: { accept: "application/json", "x-goog-api-key": this.auth.apiKey },
    });
    const json = requireOkJson(response, (value) => value as { items?: Array<{ snippet?: { description?: unknown } }> });
    const details: Array<{ record: SourceContentRecordInput; description: string }> = [];
    for (const item of json.items ?? []) {
      let record: SourceContentRecordInput;
      try {
        record = normalizeYoutubeVideo(item);
      } catch {
        continue; // A malformed item is skipped, never half-stored.
      }
      details.push({
        record,
        description: typeof item.snippet?.description === "string" ? item.snippet.description.slice(0, 10_000) : "",
      });
    }
    return details;
  }

  /**
   * Resolve a channel ID (UC...) or @handle to its channel. One data request,
   * never a search request. Returns null when YouTube has no such channel.
   */
  async resolveChannel(input: string): Promise<{ external_account_id: string; display_name: string; handle: string | null } | null> {
    const params = new URLSearchParams({ part: "snippet" });
    if (/^UC[A-Za-z0-9_-]{22}$/.test(input)) params.set("id", input);
    else if (/^@[A-Za-z0-9._-]{3,30}$/.test(input)) params.set("forHandle", input);
    else throw new ProviderHttpError({ status: 0, errorClass: "invalid_account" });
    const response = await this.transport.fetch(`https://www.googleapis.com/youtube/v3/channels?${params.toString()}`, {
      headers: { accept: "application/json", "x-goog-api-key": this.auth.apiKey },
    });
    const json = requireOkJson(response, (value) => value as {
      items?: Array<{ id?: string; snippet?: { title?: string; customUrl?: string } }>;
    });
    const item = (json.items ?? []).find((row) => typeof row.id === "string" && /^UC[A-Za-z0-9_-]{22}$/.test(row.id));
    if (!item?.id) return null;
    return { external_account_id: item.id, display_name: item.snippet?.title ?? item.id, handle: item.snippet?.customUrl ?? null };
  }

  async getChannel(externalAccountId: string) {
    const stats = await this.channelStats([externalAccountId]);
    const channel = stats.get(externalAccountId);
    if (!channel) {
      return null;
    }
    return {
      external_account_id: externalAccountId,
      handle: channel.title ?? externalAccountId,
      display_name: channel.title ?? externalAccountId,
      canonical_url: `https://www.youtube.com/channel/${externalAccountId}`,
      metadata: { subscriber_count: channel.subscribers, channel_view_count: channel.views },
    };
  }

  async getVideoMetadata(externalContentId: string) {
    const rows = await this.videos(new URLSearchParams({ part: "snippet,statistics", id: externalContentId }));
    return rows[0] ?? null;
  }

  async getTranscriptReference(externalContentId: string) {
    const row = await this.getVideoMetadata(externalContentId);
    if (!row) {
      return null;
    }
    return {
      available: Boolean(row.content.transcript_available),
      excerpt: row.content.excerpt ?? null,
    };
  }

  async getEngagementSnapshot(externalContentId: string) {
    return (await this.getVideoMetadata(externalContentId))?.engagement ?? null;
  }
}

export function createLiveRedditProvider(env: NodeJS.ProcessEnv = process.env, transport?: HttpTransport) {
  const clientId = env.REDDIT_CLIENT_ID?.trim();
  const clientSecret = env.REDDIT_CLIENT_SECRET?.trim();
  const userAgent = env.REDDIT_USER_AGENT?.trim();
  if (!clientId || !clientSecret || !userAgent) {
    return null;
  }
  const subreddits = (env.REDDIT_SUBREDDITS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new LiveRedditSourceProvider({ clientId, clientSecret, userAgent, subreddits }, transport);
}

export function createLiveYoutubeProvider(env: NodeJS.ProcessEnv = process.env, transport?: HttpTransport) {
  const apiKey = env.YOUTUBE_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }
  const channelIds = (env.YOUTUBE_CHANNEL_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new LiveYoutubeSourceProvider({ apiKey, channelIds }, transport);
}
