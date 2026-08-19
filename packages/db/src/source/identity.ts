import { createHash } from "node:crypto";

export const SOURCE_TYPES = ["youtube", "reddit", "web", "rss", "manual"] as const;
export const SOURCE_CONTENT_TYPES = ["video", "post", "comment", "article", "manual_note"] as const;
export const SOURCE_SEGMENT_KINDS = ["timestamp_range", "paragraph", "comment"] as const;
export const SOURCE_LICENSE_STATUSES = ["unknown", "reference_only", "bounded_excerpt", "licensed"] as const;
export const SOURCE_RETENTION_POLICIES = ["reference_only", "bounded_excerpt", "derived_only"] as const;
export const SOURCE_SENTIMENTS = ["positive", "negative", "neutral", "mixed", "unknown"] as const;
export const SOURCE_MENTION_CONTEXTS = ["identity", "price", "recommendation", "pull", "other"] as const;
export const SOURCE_EVENT_TYPES = ["source.content.ingested", "source.engagement.snapshot"] as const;
export const MAX_SOURCE_EXCERPT_CHARS = 500;
export const SOURCE_EXTRACTOR_VERSION = "source.extract.v1";

export class SourceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceValidationError";
  }
}

export type SourceContentRecordInput = {
  provider: string;
  provider_record_id: string;
  event_type: string;
  account: {
    external_account_id: string;
    handle?: string | null;
    display_name?: string | null;
    canonical_url?: string | null;
    metadata?: Record<string, unknown>;
  };
  content: {
    external_content_id: string;
    content_type: string;
    published_at: string;
    title?: string | null;
    summary?: string | null;
    canonical_url: string;
    language?: string | null;
    license_status?: string;
    retention_policy?: string;
    transcript_available?: boolean;
    excerpt?: string | null;
    metadata?: Record<string, unknown>;
  };
  segments?: Array<{
    kind: string;
    start_ref?: string | null;
    end_ref?: string | null;
    excerpt?: string | null;
    metadata?: Record<string, unknown>;
  }>;
  mentions?: Array<{
    raw_entity_text: string;
    mention_context?: string;
    candidate_direction?: string | null;
    candidate_timeframe?: string | null;
    candidate_price?: number | null;
    candidate_percent?: number | null;
    sentiment?: string;
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

function requireCatalog(value: string, catalog: readonly string[], label: string) {
  if (!catalog.includes(value)) {
    throw new SourceValidationError(`${label} is invalid.`);
  }
  return value;
}

export function boundSourceExcerpt(value: string | null | undefined): string | null {
  if (value == null || value === "") {
    return null;
  }
  if (value.length > MAX_SOURCE_EXCERPT_CHARS) {
    throw new SourceValidationError("Excerpt exceeds bounded retention limit.");
  }
  return value;
}

export function normalizeMentionText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

export function excerptHash(value: string | null): string | null {
  if (value == null) {
    return null;
  }
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

export function sourceFingerprint(input: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(stableValue(input))).digest("hex");
}

export function stableSourceId(prefix: string, parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32)}`;
}

export function parseSourceContentRecord(input: SourceContentRecordInput): SourceContentRecordInput {
  const provider = input.provider?.trim();
  const provider_record_id = input.provider_record_id?.trim();
  if (!provider || !provider_record_id) {
    throw new SourceValidationError("provider and provider_record_id are required.");
  }
  requireCatalog(provider, SOURCE_TYPES, "provider");
  requireCatalog(input.event_type, SOURCE_EVENT_TYPES, "event_type");
  requireCatalog(input.content.content_type, SOURCE_CONTENT_TYPES, "content_type");
  if (!input.account?.external_account_id?.trim()) {
    throw new SourceValidationError("external_account_id is required.");
  }
  if (!input.content?.external_content_id?.trim()) {
    throw new SourceValidationError("external_content_id is required.");
  }
  if (!input.content.canonical_url || !/^https?:\/\//i.test(input.content.canonical_url)) {
    throw new SourceValidationError("canonical_url must be an http(s) reference.");
  }
  if (Number.isNaN(Date.parse(input.content.published_at))) {
    throw new SourceValidationError("published_at must be an ISO timestamp.");
  }
  const retention = input.content.retention_policy ?? "bounded_excerpt";
  requireCatalog(retention, SOURCE_RETENTION_POLICIES, "retention_policy");
  if (retention === "reference_only" && input.content.excerpt) {
    throw new SourceValidationError("reference_only retention cannot store excerpt text.");
  }
  boundSourceExcerpt(input.content.excerpt ?? null);
  boundSourceExcerpt(input.content.summary ?? null);
  for (const segment of input.segments ?? []) {
    requireCatalog(segment.kind, SOURCE_SEGMENT_KINDS, "segment.kind");
    boundSourceExcerpt(segment.excerpt ?? null);
  }
  for (const mention of input.mentions ?? []) {
    if (!mention.raw_entity_text?.trim()) {
      throw new SourceValidationError("raw_entity_text is required.");
    }
    if (mention.mention_context) {
      requireCatalog(mention.mention_context, SOURCE_MENTION_CONTEXTS, "mention_context");
    }
    if (mention.sentiment) {
      requireCatalog(mention.sentiment, SOURCE_SENTIMENTS, "sentiment");
    }
    if (
      mention.sentiment_confidence != null &&
      (mention.sentiment_confidence < 0 || mention.sentiment_confidence > 1)
    ) {
      throw new SourceValidationError("sentiment_confidence must be between 0 and 1.");
    }
  }
  return { ...input, provider, provider_record_id };
}

export function deriveSentimentFoundation(input: {
  mention_context?: string;
  candidate_direction?: string | null;
}): { sentiment: string; sentiment_confidence: number | null } {
  if (input.candidate_direction === "bullish") {
    return { sentiment: "positive", sentiment_confidence: 0.4 };
  }
  if (input.candidate_direction === "bearish") {
    return { sentiment: "negative", sentiment_confidence: 0.4 };
  }
  if (input.mention_context === "pull" || input.mention_context === "identity") {
    return { sentiment: "neutral", sentiment_confidence: 0.3 };
  }
  return { sentiment: "unknown", sentiment_confidence: null };
}

export function summarizeMentionVelocity(
  rows: { contentId: string; accountKey?: string; createdAt: Date }[],
  windowSeconds: number,
) {
  const uniqueContent = new Set(rows.map((row) => row.contentId));
  const uniqueAccounts = new Set(rows.map((row) => row.accountKey).filter(Boolean));
  return {
    mention_count: rows.length,
    unique_content_count: uniqueContent.size,
    unique_account_count: uniqueAccounts.size,
    window_seconds: windowSeconds,
    rate_per_day: windowSeconds > 0 ? rows.length / (windowSeconds / 86400) : null,
  };
}
