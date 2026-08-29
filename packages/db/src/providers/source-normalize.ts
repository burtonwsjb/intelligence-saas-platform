import type { SourceContentRecordInput } from "../source/identity.js";
import { parseSourceContentRecord } from "../source/identity.js";
import { SOURCE_NORMALIZER_VERSION } from "./catalog.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function mentionsFromVendor(
  rawMentions: unknown,
  title: string | undefined,
): SourceContentRecordInput["mentions"] {
  if (Array.isArray(rawMentions) && rawMentions.length > 0) {
    return rawMentions as SourceContentRecordInput["mentions"];
  }
  if (title) {
    return [{ raw_entity_text: title, mention_context: "other" }];
  }
  return undefined;
}

export function normalizeRedditListing(raw: unknown): SourceContentRecordInput {
  const row = asRecord(raw);
  const data = asRecord(row.data);
  const src = Object.keys(data).length ? data : row;
  const id = asString(src.id ?? src.name ?? src.provider_record_id) ?? "";
  const permalink = asString(src.permalink);
  const url =
    asString(src.url ?? src.canonical_url) ??
    (permalink ? `https://www.reddit.com${permalink.startsWith("/") ? permalink : `/${permalink}`}` : "");
  const created = asNumber(src.created_utc);
  const published =
    asString(src.published_at) ?? (created != null ? new Date(created * 1000).toISOString() : "");
  const title = asString(src.title);
  const body = asString(src.selftext ?? src.body ?? src.excerpt);
  const author = asString(src.author ?? src.account_id) ?? "unknown";
  const subreddit = asString(src.subreddit ?? src.subreddit_name_prefixed);
  const record: SourceContentRecordInput = {
    provider: "reddit",
    provider_record_id: id,
    event_type: "source.content.ingested",
    account: {
      external_account_id: author,
      handle: author.startsWith("u/") ? author : `u/${author}`,
      display_name: author,
      canonical_url: `https://www.reddit.com/user/${author.replace(/^u\//, "")}`,
      metadata: { subreddit: subreddit ?? null },
    },
    content: {
      external_content_id: id,
      content_type: asString(src.content_type) === "comment" ? "comment" : "post",
      published_at: published,
      title: title ?? null,
      summary: body ? body.slice(0, 500) : null,
      canonical_url: url,
      language: asString(src.language) ?? "en",
      license_status: "reference_only",
      retention_policy: body ? "bounded_excerpt" : "reference_only",
      transcript_available: false,
      excerpt: body ? body.slice(0, 500) : null,
      metadata: {
        subreddit: subreddit ?? null,
        score: asNumber(src.score) ?? null,
        normalizer_version: SOURCE_NORMALIZER_VERSION,
      },
    },
    mentions: mentionsFromVendor(src.mentions, title),
    engagement: {
      observed_at: asString(src.observed_at) ?? new Date().toISOString(),
      upvotes: asNumber(src.ups ?? src.upvotes),
      score: asNumber(src.score),
      comments: asNumber(src.num_comments ?? src.comments),
    },
  };
  return parseSourceContentRecord(record);
}

export function normalizeYoutubeVideo(raw: unknown): SourceContentRecordInput {
  const row = asRecord(raw);
  const snippet = asRecord(row.snippet);
  const statistics = asRecord(row.statistics);
  const id = asString(row.id ?? asRecord(row.id).videoId ?? row.provider_record_id) ?? "";
  const channelId = asString(snippet.channelId ?? row.channelId ?? row.external_account_id) ?? "unknown";
  const published = asString(snippet.publishedAt ?? row.published_at) ?? "";
  const title = asString(snippet.title ?? row.title);
  const description = asString(snippet.description ?? row.description);
  const transcriptAvailable = asBool(row.transcript_available) === true;
  const transcript = asString(row.transcript ?? row.excerpt);
  const record: SourceContentRecordInput = {
    provider: "youtube",
    provider_record_id: id,
    event_type: "source.content.ingested",
    account: {
      external_account_id: channelId,
      handle: asString(snippet.channelTitle ?? row.channel_title) ?? channelId,
      display_name: asString(snippet.channelTitle ?? row.channel_title) ?? channelId,
      canonical_url: `https://www.youtube.com/channel/${channelId}`,
      metadata: {},
    },
    content: {
      external_content_id: id,
      content_type: "video",
      published_at: published,
      title: title ?? null,
      summary: description ? description.slice(0, 500) : null,
      canonical_url: asString(row.canonical_url) ?? `https://www.youtube.com/watch?v=${id}`,
      language: asString(snippet.defaultLanguage ?? snippet.defaultAudioLanguage ?? row.language) ?? null,
      license_status: "reference_only",
      retention_policy: transcript ? "bounded_excerpt" : "reference_only",
      transcript_available: transcriptAvailable && Boolean(transcript),
      excerpt: transcriptAvailable ? (transcript ? transcript.slice(0, 500) : null) : null,
      metadata: {
        normalizer_version: SOURCE_NORMALIZER_VERSION,
        transcript_available: transcriptAvailable && Boolean(transcript),
      },
    },
    mentions: mentionsFromVendor(row.mentions, title),
    engagement: {
      observed_at: asString(row.observed_at) ?? new Date().toISOString(),
      views: asNumber(statistics.viewCount ?? row.views),
      likes: asNumber(statistics.likeCount ?? row.likes),
      comments: asNumber(statistics.commentCount ?? row.comments),
    },
  };
  return parseSourceContentRecord(record);
}
