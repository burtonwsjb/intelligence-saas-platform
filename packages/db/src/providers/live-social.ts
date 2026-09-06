import type { SourceContentRecordInput } from "../source/identity.js";
import type { RedditSourceProvider, YoutubeSourceProvider } from "../source/provider.js";
import { normalizeRedditListing, normalizeYoutubeVideo } from "./source-normalize.js";
import {
  createFetchTransport,
  requireOkJson,
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
    const url = `https://www.googleapis.com/youtube/v3/videos?${params.toString()}&key=${this.auth.apiKey}`;
    const response = await this.transport.fetch(url, { headers: { accept: "application/json" } });
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
      key: this.auth.apiKey,
    });
    const response = await this.transport.fetch(
      `https://www.googleapis.com/youtube/v3/channels?${params.toString()}`,
      { headers: { accept: "application/json" } },
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
      key: this.auth.apiKey,
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
    const response = await this.transport.fetch(searchUrl, { headers: { accept: "application/json" } });
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
