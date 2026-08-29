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
    return { ok: true as const, mode: "sandbox_fixture" as const };
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

  async searchPosts(query: { language?: string; limit?: number }) {
    const limit = Math.min(query.limit ?? 10, 25);
    const sub = this.auth.subreddits[0] ?? "PokemonTCG";
    const rows = await this.listing(`/r/${encodeURIComponent(sub)}/new?limit=${limit}`);
    return rows.filter((row) => !query.language || row.content.language === query.language);
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
    return { ok: true as const, mode: "sandbox_fixture" as const };
  }

  private async videos(params: URLSearchParams): Promise<SourceContentRecordInput[]> {
    const url = `https://www.googleapis.com/youtube/v3/videos?${params.toString()}&key=${this.auth.apiKey}`;
    const response = await this.transport.fetch(url, { headers: { accept: "application/json" } });
    const json = requireOkJson(response, (value) => value as { items?: unknown[] });
    return (json.items ?? []).map((item) => normalizeYoutubeVideo(item));
  }

  async searchContent(query: { language?: string; limit?: number }) {
    const channel = this.auth.channelIds[0];
    if (!channel) {
      return [];
    }
    const search = new URLSearchParams({
      part: "snippet",
      channelId: channel,
      maxResults: String(Math.min(query.limit ?? 5, 10)),
      order: "date",
      type: "video",
      key: this.auth.apiKey,
    });
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
    return rows.filter((row) => !query.language || row.content.language === query.language);
  }

  async getChannel(externalAccountId: string) {
    const rows = await this.searchContent({});
    return rows.find((row) => row.account.external_account_id === externalAccountId)?.account ?? null;
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
  const subreddits = (env.REDDIT_SUBREDDITS ?? "PokemonTCG")
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
