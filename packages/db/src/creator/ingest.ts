import { eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { creator, creatorCall, creatorCallOutcome, creatorSourceAccount } from "../schema/creator.js";
import { sourceAccount, sourceContent, sourceContentSegment, sourceMention } from "../schema/source.js";
import { resolveSourceMention } from "../resolution/resolve.js";
import { DeterministicCreatorCallExtractor, type CreatorCallExtractor } from "./extract.js";
import {
  CREATOR_EXTRACTOR_VERSION,
  fingerprintCreatorCall,
  mayBindCallPrinting,
  stableCreatorId,
  type ExtractedCallCandidate,
} from "./identity.js";
import { priceAtCall } from "./price-at-call.js";

export async function ensureCreatorForSourceAccount(db: Database, sourceAccountId: string) {
  const existing = await db
    .select()
    .from(creatorSourceAccount)
    .where(eq(creatorSourceAccount.sourceAccountId, sourceAccountId))
    .limit(1);
  if (existing[0]) {
    const [row] = await db.select().from(creator).where(eq(creator.id, existing[0].creatorId)).limit(1);
    await db
      .update(creator)
      .set({ lastSeenAt: new Date() })
      .where(eq(creator.id, existing[0].creatorId));
    return { creator: row!, link: existing[0] };
  }
  const [account] = await db.select().from(sourceAccount).where(eq(sourceAccount.id, sourceAccountId)).limit(1);
  if (!account) {
    throw new Error("source account not found.");
  }
  const creatorId = stableCreatorId([account.sourceType, account.externalAccountId]);
  await db.insert(creator).values({
    id: creatorId,
    displayName: account.displayName ?? account.handle,
    metadata: { provisional: true },
  }).onConflictDoNothing();
  const [created] = await db.select().from(creator).where(eq(creator.id, creatorId)).limit(1);
  const linkId = stableCreatorId(["link", creatorId, sourceAccountId]);
  await db.insert(creatorSourceAccount).values({
    id: linkId,
    creatorId,
    sourceAccountId,
    linkState: "unresolved_ownership",
  }).onConflictDoNothing();
  const [link] = await db
    .select()
    .from(creatorSourceAccount)
    .where(eq(creatorSourceAccount.sourceAccountId, sourceAccountId))
    .limit(1);
  return { creator: created!, link: link! };
}

export async function linkCreatorAccount(
  db: Database,
  input: { creatorId: string; sourceAccountId: string; linkState?: "confirmed" | "unresolved_ownership" },
) {
  const existing = await db
    .select()
    .from(creatorSourceAccount)
    .where(eq(creatorSourceAccount.sourceAccountId, input.sourceAccountId))
    .limit(1);
  if (existing[0] && existing[0].creatorId !== input.creatorId) {
    throw new Error("source account is already linked to a different creator.");
  }
  if (existing[0]) {
    return existing[0];
  }
  const id = stableCreatorId(["link", input.creatorId, input.sourceAccountId]);
  await db.insert(creatorSourceAccount).values({
    id,
    creatorId: input.creatorId,
    sourceAccountId: input.sourceAccountId,
    linkState: input.linkState ?? "confirmed",
  });
  const [row] = await db.select().from(creatorSourceAccount).where(eq(creatorSourceAccount.id, id)).limit(1);
  return row!;
}

async function persistCall(
  db: Database,
  input: {
    creatorId: string;
    sourceAccountId: string;
    contentId: string;
    segmentId: string | null;
    mentionId: string | null;
    publishedAt: Date;
    printingId: string | null;
    conceptId: string | null;
    resolutionAttemptId: string | null;
    resolutionStatus: string;
    resolutionConfidence: string | null;
    candidate: ExtractedCallCandidate;
    evidence: Record<string, unknown>;
    revisesCallId?: string | null;
  },
) {
  const fingerprint = fingerprintCreatorCall([
    input.creatorId,
    input.contentId,
    input.mentionId ?? "",
    input.candidate.direction,
    input.printingId ?? "",
    input.candidate.horizon_code,
    CREATOR_EXTRACTOR_VERSION,
  ]);
  const existing = await db.select().from(creatorCall).where(eq(creatorCall.fingerprint, fingerprint)).limit(1);
  if (existing[0] && !input.revisesCallId) {
    return { status: "duplicate" as const, call: existing[0] };
  }
  const boundPrinting = mayBindCallPrinting(input.resolutionStatus) ? input.printingId : null;
  const price = boundPrinting
    ? await priceAtCall(db, { printingId: boundPrinting, publishedAt: input.publishedAt })
    : null;
  const id = crypto.randomUUID();
  await db.insert(creatorCall).values({
    id,
    creatorId: input.creatorId,
    sourceAccountId: input.sourceAccountId,
    contentId: input.contentId,
    segmentId: input.segmentId,
    mentionId: input.mentionId,
    publishedAt: input.publishedAt,
    printingId: boundPrinting,
    conceptId: input.conceptId,
    resolutionAttemptId: input.resolutionAttemptId,
    resolutionStatus: input.resolutionStatus,
    resolutionConfidence: input.resolutionConfidence,
    priceAtCall: price?.price ?? null,
    priceCurrency: price?.currency ?? null,
    priceSource: price?.source ?? null,
    priceObservedAt: price?.observedAt ?? null,
    priceMethodVersion: price?.methodVersion ?? null,
    direction: input.candidate.direction,
    targetPrice: input.candidate.target_price == null ? null : String(input.candidate.target_price),
    targetPercent: input.candidate.target_percent == null ? null : String(input.candidate.target_percent),
    horizonCode: input.candidate.horizon_code,
    horizonCustomDays:
      input.candidate.horizon_custom_days == null ? null : String(input.candidate.horizon_custom_days),
    statedConfidence:
      input.candidate.stated_confidence == null ? null : input.candidate.stated_confidence.toFixed(4),
    extractionConfidence: input.candidate.extraction_confidence.toFixed(4),
    extractionVersion: CREATOR_EXTRACTOR_VERSION,
    fingerprint: input.revisesCallId ? `${fingerprint}:${id}` : fingerprint,
    status: "finalized",
    revisesCallId: input.revisesCallId ?? null,
    evidence: input.evidence,
  });
  await db.insert(creatorCallOutcome).values({
    id: crypto.randomUUID(),
    callId: id,
    evaluationStatus: "pending",
    startingPrice: price?.price ?? null,
  });
  const [call] = await db.select().from(creatorCall).where(eq(creatorCall.id, id)).limit(1);
  return { status: "processed" as const, call: call! };
}

export async function extractCreatorCallsFromContent(
  db: Database,
  contentId: string,
  extractor: CreatorCallExtractor = new DeterministicCreatorCallExtractor(),
) {
  const [content] = await db.select().from(sourceContent).where(eq(sourceContent.id, contentId)).limit(1);
  if (!content) {
    throw new Error("source content not found.");
  }
  const { creator: creatorRow } = await ensureCreatorForSourceAccount(db, content.accountId);
  const mentions = await db.select().from(sourceMention).where(eq(sourceMention.contentId, contentId));
  const segments = await db.select().from(sourceContentSegment).where(eq(sourceContentSegment.contentId, contentId));
  const results = [];
  for (const mention of mentions) {
    const segment = segments.find((row) => row.id === mention.segmentId);
    const text = [content.title, content.summary, content.excerpt, segment?.excerpt, mention.rawEntityText]
      .filter(Boolean)
      .join(" ");
    const candidate = await extractor.extract({
      text,
      mentionContext: mention.mentionContext,
      candidatePrice: mention.candidatePrice,
      candidatePercent: mention.candidatePercent,
      candidateTimeframe: mention.candidateTimeframe,
    });
    if (!candidate) {
      results.push({ mentionId: mention.id, status: "not_a_call" as const });
      continue;
    }
    const resolution = await resolveSourceMention(db, mention.id);
    const result = await persistCall(db, {
      creatorId: creatorRow.id,
      sourceAccountId: content.accountId,
      contentId: content.id,
      segmentId: mention.segmentId,
      mentionId: mention.id,
      publishedAt: content.publishedAt,
      printingId: resolution.attempt.chosenPrintingId,
      conceptId: resolution.attempt.chosenConceptId,
      resolutionAttemptId: resolution.attempt.id,
      resolutionStatus: resolution.attempt.status,
      resolutionConfidence: resolution.attempt.confidence,
      candidate,
      evidence: {
        extractor_evidence: candidate.evidence,
        segment_id: mention.segmentId,
        published_at: content.publishedAt.toISOString(),
      },
    });
    results.push({ mentionId: mention.id, ...result });
  }
  return results;
}

export async function reviseCreatorCall(
  db: Database,
  input: { callId: string; candidate: ExtractedCallCandidate; note: string },
) {
  const [original] = await db.select().from(creatorCall).where(eq(creatorCall.id, input.callId)).limit(1);
  if (!original) {
    throw new Error("creator call not found.");
  }
  return persistCall(db, {
    creatorId: original.creatorId,
    sourceAccountId: original.sourceAccountId,
    contentId: original.contentId,
    segmentId: original.segmentId,
    mentionId: original.mentionId,
    publishedAt: original.publishedAt,
    printingId: original.printingId,
    conceptId: original.conceptId,
    resolutionAttemptId: original.resolutionAttemptId,
    resolutionStatus: original.resolutionStatus,
    resolutionConfidence: original.resolutionConfidence,
    candidate: input.candidate,
    evidence: { ...(original.evidence as Record<string, unknown>), revision_note: input.note },
    revisesCallId: original.id,
  });
}
