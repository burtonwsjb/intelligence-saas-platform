export const SOURCE_TYPES = ["youtube", "reddit", "web", "rss", "manual"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const SOURCE_CONTENT_TYPES = ["video", "post", "comment", "article", "manual_note"] as const;
export type SourceContentType = (typeof SOURCE_CONTENT_TYPES)[number];

export const SOURCE_SEGMENT_KINDS = ["timestamp_range", "paragraph", "comment"] as const;
export type SourceSegmentKind = (typeof SOURCE_SEGMENT_KINDS)[number];

export const SOURCE_LICENSE_STATUSES = [
  "unknown",
  "reference_only",
  "bounded_excerpt",
  "licensed",
] as const;
export type SourceLicenseStatus = (typeof SOURCE_LICENSE_STATUSES)[number];

export const SOURCE_RETENTION_POLICIES = [
  "reference_only",
  "bounded_excerpt",
  "derived_only",
] as const;
export type SourceRetentionPolicy = (typeof SOURCE_RETENTION_POLICIES)[number];

export const SOURCE_SENTIMENTS = ["positive", "negative", "neutral", "mixed", "unknown"] as const;
export type SourceSentiment = (typeof SOURCE_SENTIMENTS)[number];

export const SOURCE_MENTION_CONTEXTS = [
  "identity",
  "price",
  "recommendation",
  "pull",
  "other",
] as const;
export type SourceMentionContext = (typeof SOURCE_MENTION_CONTEXTS)[number];

export const SOURCE_EVENT_TYPES = [
  "source.content.ingested",
  "source.engagement.snapshot",
] as const;
export type SourceEventType = (typeof SOURCE_EVENT_TYPES)[number];

export const MAX_SOURCE_EXCERPT_CHARS = 500;
export const SOURCE_EXTRACTOR_VERSION = "source.extract.v1";

export class SourceContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceContractError";
  }
}

export function isSourceType(value: string): value is SourceType {
  return (SOURCE_TYPES as readonly string[]).includes(value);
}

export function parseSourceType(value: unknown): SourceType {
  if (typeof value !== "string" || !isSourceType(value)) {
    throw new SourceContractError("source_type is invalid.");
  }
  return value;
}

export function boundSourceExcerpt(value: string | null | undefined): string | null {
  if (value == null || value === "") {
    return null;
  }
  if (value.length > MAX_SOURCE_EXCERPT_CHARS) {
    throw new SourceContractError("Excerpt exceeds bounded retention limit.");
  }
  return value;
}

export function normalizeMentionText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

export type SourceContentRecord = {
  provider: SourceType;
  provider_record_id: string;
  event_type: SourceEventType | string;
  account: {
    external_account_id: string;
    handle?: string | null;
    display_name?: string | null;
    canonical_url?: string | null;
    metadata?: Record<string, unknown>;
  };
  content: {
    external_content_id: string;
    content_type: SourceContentType;
    published_at: string;
    title?: string | null;
    summary?: string | null;
    canonical_url: string;
    language?: string | null;
    license_status?: SourceLicenseStatus;
    retention_policy?: SourceRetentionPolicy;
    transcript_available?: boolean;
    excerpt?: string | null;
    metadata?: Record<string, unknown>;
  };
  segments?: Array<{
    kind: SourceSegmentKind;
    start_ref?: string | null;
    end_ref?: string | null;
    excerpt?: string | null;
    metadata?: Record<string, unknown>;
  }>;
  mentions?: Array<{
    raw_entity_text: string;
    mention_context?: SourceMentionContext;
    candidate_direction?: string | null;
    candidate_timeframe?: string | null;
    candidate_price?: number | null;
    candidate_percent?: number | null;
    sentiment?: SourceSentiment;
    sentiment_confidence?: number | null;
    segment_index?: number | null;
  }>;
  engagement?: {
    observed_at: string;
    views?: number | null;
    likes?: number | null;
    comments?: number | null;
    upvotes?: number | null;
    score?: number | null;
    reply_count?: number | null;
  };
};

export function parseSourceContentRecord(input: SourceContentRecord): SourceContentRecord {
  parseSourceType(input.provider);
  if (!input.provider_record_id?.trim()) {
    throw new SourceContractError("provider_record_id is required.");
  }
  if (!input.account?.external_account_id?.trim()) {
    throw new SourceContractError("external_account_id is required.");
  }
  if (!input.content?.external_content_id?.trim()) {
    throw new SourceContractError("external_content_id is required.");
  }
  if (!input.content.canonical_url?.trim()) {
    throw new SourceContractError("canonical_url is required.");
  }
  if (!/^https?:\/\//i.test(input.content.canonical_url)) {
    throw new SourceContractError("canonical_url must be an http(s) reference.");
  }
  if (Number.isNaN(Date.parse(input.content.published_at))) {
    throw new SourceContractError("published_at must be an ISO timestamp.");
  }
  boundSourceExcerpt(input.content.excerpt ?? input.content.summary ?? null);
  if ((SOURCE_CONTENT_TYPES as readonly string[]).includes(input.content.content_type) === false) {
    throw new SourceContractError("content_type is invalid.");
  }
  return input;
}
