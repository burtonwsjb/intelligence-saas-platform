/**
 * Shared storage for card names detected in longer text (a transcript window,
 * a website post): one bounded segment per window that names a card, one
 * mention per detected card, its sentiment row and a resolution attempt.
 * Used by the transcript backfill and the website feed sync so both keep the
 * same retention rule and resolver hints.
 */
import type { Database } from "../client.js";
import { analyzeSourceSentiment } from "../providers/sentiment.js";
import { resolveSourceMention } from "../resolution/resolve.js";
import { sourceSentiment } from "../schema/provider.js";
import { sourceContentSegment, sourceMention } from "../schema/source.js";
import { boundSourceExcerpt, excerptHash, stableSourceId } from "./identity.js";

/** Longest stored excerpt of a window, under the 500-character source limit. */
export const CARD_MENTION_EXCERPT_MAX_CHARS = 480;
const SNIPPET_CONTEXT_CHARS = 100;

/**
 * A bounded excerpt of a window: the text around each mention (merged when
 * they overlap, joined with " … "), stopping before CARD_MENTION_EXCERPT_MAX_CHARS.
 */
export function boundedWindowExcerpt(text: string, mentions: Array<{ start: number; end: number }>): string {
  const ranges = mentions
    .map((mention) => {
      let from = Math.max(0, mention.start - SNIPPET_CONTEXT_CHARS);
      let to = Math.min(text.length, mention.end + SNIPPET_CONTEXT_CHARS);
      while (from > 0 && from < mention.start && !/\s/.test(text[from - 1]!)) from += 1;
      while (to < text.length && to > mention.end && !/\s/.test(text[to]!)) to -= 1;
      return { from, to };
    })
    .sort((a, b) => a.from - b.from);
  const merged: Array<{ from: number; to: number }> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else merged.push({ ...range });
  }
  let excerpt = "";
  for (const range of merged) {
    const piece = text.slice(range.from, range.to).trim();
    const next = excerpt ? `${excerpt} … ${piece}` : piece;
    if (next.length > CARD_MENTION_EXCERPT_MAX_CHARS) {
      if (!excerpt) excerpt = piece.slice(0, CARD_MENTION_EXCERPT_MAX_CHARS).trim();
      break;
    }
    excerpt = next;
  }
  return excerpt;
}

/** The stable id of a detected-card mention. */
export function cardMentionId(contentId: string, normalized: string, extractionVersion: string, ref: string) {
  return stableSourceId("smn", [contentId, normalized, "other", extractionVersion, ref]);
}

export type CardMentionSegment = {
  id: string;
  kind: "timestamp_range" | "paragraph";
  startRef: string;
  endRef: string;
  excerpt: string;
  metadata: Record<string, unknown>;
  mentions: Array<{
    id: string;
    rawEntityText: string;
    normalized: string;
    /** Stored under `metadata[hintsKey]`; the resolver reads card_name, collector_number and set_key. */
    hints: Record<string, unknown>;
  }>;
};

/**
 * Inserts the segments and their mentions (existing rows are kept as they
 * are), scores each new mention's sentiment and resolves it. Returns how many
 * mentions were new. Run inside a platform-context transaction.
 */
export async function storeCardMentionSegments(
  tx: Database,
  input: {
    contentId: string;
    contentTitle: string | null;
    extractionVersion: string;
    hintsKey: "transcript" | "card_detect";
    segments: CardMentionSegment[];
  },
): Promise<{ mentions: number }> {
  let mentions = 0;
  for (const segment of input.segments) {
    const excerpt = boundSourceExcerpt(segment.excerpt);
    await tx
      .insert(sourceContentSegment)
      .values({
        id: segment.id,
        contentId: input.contentId,
        kind: segment.kind,
        startRef: segment.startRef,
        endRef: segment.endRef,
        excerpt,
        excerptHash: excerptHash(excerpt),
        metadata: segment.metadata,
      })
      .onConflictDoNothing();
    for (const mention of segment.mentions) {
      const inserted = await tx
        .insert(sourceMention)
        .values({
          id: mention.id,
          contentId: input.contentId,
          segmentId: segment.id,
          rawEntityText: mention.rawEntityText,
          normalizedEntityText: mention.normalized,
          mentionContext: "other",
          sentiment: "unknown",
          extractionVersion: input.extractionVersion,
          metadata: {
            printing_id: null,
            resolution_status: "unresolved",
            [input.hintsKey]: mention.hints,
          },
        })
        .onConflictDoNothing()
        .returning({ id: sourceMention.id });
      if (inserted.length === 0) continue;
      mentions += 1;
      const analysis = analyzeSourceSentiment({
        text: `${input.contentTitle ?? ""} ${segment.excerpt} ${mention.rawEntityText}`,
        mention_context: "other",
      });
      await tx
        .insert(sourceSentiment)
        .values({
          id: stableSourceId("sst", [mention.id, analysis.analyzer_version]),
          mentionId: mention.id,
          analyzerVersion: analysis.analyzer_version,
          direction: analysis.direction,
          strength: analysis.strength,
          confidence: analysis.confidence == null ? null : String(analysis.confidence),
          subject: analysis.subject,
          entityKind: analysis.entity_kind,
          timeHorizon: analysis.time_horizon,
          marketRelevance: analysis.market_relevance,
          excitement: analysis.excitement,
          purchaseIntent: analysis.purchase_intent,
          priceExpectation: analysis.price_expectation,
          creatorRecommendation: analysis.creator_recommendation,
          marketConcern: analysis.market_concern,
          evidence: analysis.evidence,
        })
        .onConflictDoNothing();
      try {
        await resolveSourceMention(tx, mention.id);
      } catch {
        // Resolution failures stay in entity_resolution_attempt; the mention is kept.
      }
    }
  }
  return { mentions };
}
