import { and, eq } from "drizzle-orm";
import {
  sourceAccount,
  sourceContent,
  sourceContentSegment,
  sourceEngagementSnapshot,
  sourceIngest,
  sourceMention,
} from "../schema/source.js";
import type { Database } from "../client.js";
import {
  SOURCE_EXTRACTOR_VERSION,
  boundSourceExcerpt,
  deriveSentimentFoundation,
  excerptHash,
  normalizeMentionText,
  parseSourceContentRecord,
  sourceFingerprint,
  stableSourceId,
  SourceValidationError,
  type SourceContentRecordInput,
} from "./identity.js";

export type SourceIngestResult = {
  status: "processed" | "duplicate";
  ingestId: string;
  contentId: string | null;
};

function materialFingerprint(input: SourceContentRecordInput) {
  return sourceFingerprint({
    provider: input.provider,
    provider_record_id: input.provider_record_id,
    account: input.account,
    content: {
      external_content_id: input.content.external_content_id,
      content_type: input.content.content_type,
      published_at: input.content.published_at,
      title: input.content.title ?? null,
      summary: input.content.summary ?? null,
      canonical_url: input.content.canonical_url,
      language: input.content.language ?? null,
      license_status: input.content.license_status ?? "reference_only",
      retention_policy: input.content.retention_policy ?? "bounded_excerpt",
      excerpt: input.content.excerpt ?? null,
    },
    segments: input.segments ?? [],
    mentions: input.mentions ?? [],
    engagement: input.engagement ?? null,
  });
}

async function upsertAccount(db: Database, input: SourceContentRecordInput) {
  const id = stableSourceId("sac", [input.provider, input.account.external_account_id]);
  const now = new Date();
  await db
    .insert(sourceAccount)
    .values({
      id,
      sourceType: input.provider,
      externalAccountId: input.account.external_account_id,
      handle: input.account.handle ?? null,
      displayName: input.account.display_name ?? null,
      canonicalUrl: input.account.canonical_url ?? null,
      metadata: input.account.metadata ?? {},
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .onConflictDoNothing();
  await db
    .update(sourceAccount)
    .set({
      lastSeenAt: now,
      handle: input.account.handle ?? null,
      displayName: input.account.display_name ?? null,
    })
    .where(eq(sourceAccount.id, id));
  return id;
}

export async function ingestSourceContentRecord(
  db: Database,
  raw: SourceContentRecordInput,
): Promise<SourceIngestResult> {
  const input = parseSourceContentRecord(raw);
  const ingestId = stableSourceId("sin", [input.provider, input.provider_record_id]);
  const fingerprint = materialFingerprint(input);

  const [existing] = await db
    .select()
    .from(sourceIngest)
    .where(
      and(eq(sourceIngest.sourceType, input.provider), eq(sourceIngest.sourceRecordId, input.provider_record_id)),
    )
    .limit(1);
  if (existing && existing.processingStatus === "processed" && existing.fingerprint === fingerprint) {
    return { status: "duplicate", ingestId: existing.id, contentId: existing.contentId };
  }
  if (existing && existing.processingStatus === "processed" && existing.fingerprint !== fingerprint) {
    throw new SourceValidationError("Source record fingerprint conflict; original content was not rewritten.");
  }

  await db
    .insert(sourceIngest)
    .values({
      id: ingestId,
      sourceType: input.provider,
      sourceRecordId: input.provider_record_id,
      eventType: input.event_type,
      fingerprint,
      payload: input as unknown as Record<string, unknown>,
      processingStatus: "received",
    })
    .onConflictDoNothing();

  const accountId = await upsertAccount(db, input);
  const contentId = stableSourceId("sct", [input.provider, input.content.external_content_id]);
  const excerpt = boundSourceExcerpt(input.content.excerpt ?? null);
  await db
    .insert(sourceContent)
    .values({
      id: contentId,
      sourceType: input.provider,
      externalContentId: input.content.external_content_id,
      accountId,
      publishedAt: new Date(input.content.published_at),
      title: input.content.title ?? null,
      summary: boundSourceExcerpt(input.content.summary ?? null),
      canonicalUrl: input.content.canonical_url,
      contentType: input.content.content_type,
      language: input.content.language ?? null,
      licenseStatus: input.content.license_status ?? "reference_only",
      retentionPolicy: input.content.retention_policy ?? "bounded_excerpt",
      transcriptAvailable: input.content.transcript_available ?? false,
      excerpt,
      excerptHash: excerptHash(excerpt),
      fingerprint,
      metadata: input.content.metadata ?? {},
    })
    .onConflictDoNothing();

  const segmentIds: string[] = [];
  for (const [index, segment] of (input.segments ?? []).entries()) {
    const segmentExcerpt = boundSourceExcerpt(segment.excerpt ?? null);
    const segmentId = stableSourceId("ssg", [
      contentId,
      segment.kind,
      segment.start_ref ?? "",
      segment.end_ref ?? "",
      String(index),
    ]);
    segmentIds.push(segmentId);
    await db
      .insert(sourceContentSegment)
      .values({
        id: segmentId,
        contentId,
        kind: segment.kind,
        startRef: segment.start_ref ?? null,
        endRef: segment.end_ref ?? null,
        excerpt: segmentExcerpt,
        excerptHash: excerptHash(segmentExcerpt),
        metadata: segment.metadata ?? {},
      })
      .onConflictDoNothing();
  }

  for (const mention of input.mentions ?? []) {
    const derived = deriveSentimentFoundation({
      mention_context: mention.mention_context,
      candidate_direction: mention.candidate_direction,
    });
    const normalized = normalizeMentionText(mention.raw_entity_text);
    const mentionId = stableSourceId("smn", [
      contentId,
      normalized,
      mention.mention_context ?? "other",
      String(mention.segment_index ?? ""),
    ]);
    await db
      .insert(sourceMention)
      .values({
        id: mentionId,
        contentId,
        segmentId:
          mention.segment_index == null ? null : (segmentIds[mention.segment_index] ?? null),
        rawEntityText: mention.raw_entity_text,
        normalizedEntityText: normalized,
        mentionContext: mention.mention_context ?? "other",
        candidateDirection: mention.candidate_direction ?? null,
        candidateTimeframe: mention.candidate_timeframe ?? null,
        candidatePrice: mention.candidate_price == null ? null : String(mention.candidate_price),
        candidatePercent: mention.candidate_percent == null ? null : String(mention.candidate_percent),
        sentiment: mention.sentiment ?? derived.sentiment,
        sentimentConfidence:
          mention.sentiment_confidence == null
            ? derived.sentiment_confidence == null
              ? null
              : String(derived.sentiment_confidence)
            : String(mention.sentiment_confidence),
        extractionVersion: SOURCE_EXTRACTOR_VERSION,
        metadata: { printing_id: null, resolution_status: "unresolved" },
      })
      .onConflictDoNothing();
  }

  if (input.engagement) {
    const publishedAge = Math.max(
      0,
      Math.floor(
        (Date.parse(input.engagement.observed_at) - Date.parse(input.content.published_at)) / 1000,
      ),
    );
    await db
      .insert(sourceEngagementSnapshot)
      .values({
        id: stableSourceId("seg", [contentId, input.provider_record_id]),
        contentId,
        observedAt: new Date(input.engagement.observed_at),
        views: input.engagement.views ?? null,
        likes: input.engagement.likes ?? null,
        comments: input.engagement.comments ?? null,
        upvotes: input.engagement.upvotes ?? null,
        score: input.engagement.score ?? null,
        replyCount: input.engagement.reply_count ?? null,
        publishedAgeSeconds: publishedAge,
        sourceRecordId: input.provider_record_id,
        fingerprint,
      })
      .onConflictDoNothing();
  }

  await db
    .update(sourceIngest)
    .set({ processingStatus: "processed", contentId, fingerprint, updatedAt: new Date() })
    .where(eq(sourceIngest.id, ingestId));

  return { status: "processed", ingestId, contentId };
}

export async function receiveSourceContentRecord(db: Database, raw: SourceContentRecordInput) {
  const input = parseSourceContentRecord(raw);
  const ingestId = stableSourceId("sin", [input.provider, input.provider_record_id]);
  await db
    .insert(sourceIngest)
    .values({
      id: ingestId,
      sourceType: input.provider,
      sourceRecordId: input.provider_record_id,
      eventType: input.event_type,
      fingerprint: materialFingerprint(input),
      payload: input as unknown as Record<string, unknown>,
      processingStatus: "received",
    })
    .onConflictDoNothing();
  return { ingestId };
}

export async function normalizeSourceIntelligenceIngest(db: Database, ingestId: string) {
  const [row] = await db.select().from(sourceIngest).where(eq(sourceIngest.id, ingestId)).limit(1);
  if (!row) {
    throw new SourceValidationError("Source ingest record is missing.");
  }
  if (row.processingStatus === "processed") {
    return { status: "duplicate" as const, ingestId: row.id, contentId: row.contentId };
  }
  return ingestSourceContentRecord(db, row.payload as SourceContentRecordInput);
}

export async function markSourceIngestFailed(db: Database, ingestId: string) {
  await db
    .update(sourceIngest)
    .set({ processingStatus: "failed", updatedAt: new Date() })
    .where(eq(sourceIngest.id, ingestId));
}

export async function listSourceContent(db: Database) {
  return db.select().from(sourceContent);
}

export async function listSourceMentions(db: Database, contentId?: string) {
  if (!contentId) {
    return db.select().from(sourceMention);
  }
  return db.select().from(sourceMention).where(eq(sourceMention.contentId, contentId));
}

export async function listSourceAccounts(db: Database) {
  return db.select().from(sourceAccount);
}

export async function listSourceSegments(db: Database, contentId: string) {
  return db.select().from(sourceContentSegment).where(eq(sourceContentSegment.contentId, contentId));
}

export async function listSourceEngagement(db: Database, contentId: string) {
  return db
    .select()
    .from(sourceEngagementSnapshot)
    .where(eq(sourceEngagementSnapshot.contentId, contentId));
}

export async function getSourceContentByExternal(
  db: Database,
  input: { sourceType: string; externalContentId: string },
) {
  const [row] = await db
    .select()
    .from(sourceContent)
    .where(
      and(
        eq(sourceContent.sourceType, input.sourceType),
        eq(sourceContent.externalContentId, input.externalContentId),
      ),
    )
    .limit(1);
  return row ?? null;
}
