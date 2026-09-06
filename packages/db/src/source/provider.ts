import type { SourceContentRecordInput } from "./identity.js";
import { sourceIntelligenceFixtures } from "./fixtures.js";

export interface YoutubeSourceProvider {
  searchContent(query: { language?: string; limit?: number; q?: string }): Promise<SourceContentRecordInput[]>;
  getChannel(externalAccountId: string): Promise<SourceContentRecordInput["account"] | null>;
  getVideoMetadata(externalContentId: string): Promise<SourceContentRecordInput | null>;
  getTranscriptReference(externalContentId: string): Promise<{
    available: boolean;
    excerpt: string | null;
  } | null>;
  getEngagementSnapshot(externalContentId: string): Promise<SourceContentRecordInput["engagement"] | null>;
  healthCheck(): Promise<{ ok: true; mode: "sandbox_fixture" | "live" }>;
}

export interface RedditSourceProvider {
  searchPosts(query: { language?: string; limit?: number; q?: string }): Promise<SourceContentRecordInput[]>;
  getPost(externalContentId: string): Promise<SourceContentRecordInput | null>;
  getSubreddit(name: string): Promise<{ name: string } | null>;
  getEngagementSnapshot(externalContentId: string): Promise<SourceContentRecordInput["engagement"] | null>;
  healthCheck(): Promise<{ ok: true; mode: "sandbox_fixture" | "live" }>;
}

export class FixtureYoutubeSourceProvider implements YoutubeSourceProvider {
  constructor(private readonly records: SourceContentRecordInput[] = sourceIntelligenceFixtures()) {}

  async healthCheck() {
    return { ok: true as const, mode: "sandbox_fixture" as const };
  }

  private youtube() {
    return this.records.filter((row) => row.provider === "youtube");
  }

  async searchContent(query: { language?: string; limit?: number; q?: string }) {
    const hay = query.q?.trim().toLowerCase();
    return this.youtube()
      .filter((row) => !query.language || row.content.language === query.language)
      .filter((row) => {
        if (!hay) {
          return true;
        }
        const text = `${row.content.title ?? ""} ${row.content.summary ?? ""}`.toLowerCase();
        return hay.split(/\s+/).some((token) => token.length > 2 && text.includes(token));
      })
      .slice(0, query.limit ?? 10);
  }

  async getChannel(externalAccountId: string) {
    return this.youtube().find((row) => row.account.external_account_id === externalAccountId)?.account ?? null;
  }

  async getVideoMetadata(externalContentId: string) {
    return this.youtube().find((row) => row.content.external_content_id === externalContentId) ?? null;
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

export class FixtureRedditSourceProvider implements RedditSourceProvider {
  constructor(private readonly records: SourceContentRecordInput[] = sourceIntelligenceFixtures()) {}

  async healthCheck() {
    return { ok: true as const, mode: "sandbox_fixture" as const };
  }

  private reddit() {
    return this.records.filter((row) => row.provider === "reddit");
  }

  async searchPosts(query: { language?: string; limit?: number; q?: string }) {
    const hay = query.q?.trim().toLowerCase();
    return this.reddit()
      .filter((row) => !query.language || row.content.language === query.language)
      .filter((row) => {
        if (!hay) {
          return true;
        }
        const text = `${row.content.title ?? ""} ${row.content.summary ?? ""}`.toLowerCase();
        return hay.split(/\s+/).some((token) => token.length > 2 && text.includes(token));
      })
      .slice(0, query.limit ?? 10);
  }

  async getPost(externalContentId: string) {
    return this.reddit().find((row) => row.content.external_content_id === externalContentId) ?? null;
  }

  async getSubreddit(name: string) {
    return name ? { name } : null;
  }

  async getEngagementSnapshot(externalContentId: string) {
    return (await this.getPost(externalContentId))?.engagement ?? null;
  }
}
