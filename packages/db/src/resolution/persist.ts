import { desc, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import {
  entityResolutionAttempt,
  entityResolutionCandidate,
  entityResolutionCorrection,
} from "../schema/resolution.js";
import { sourceContent, sourceMention } from "../schema/source.js";
import {
  EntityResolutionError,
  mayBindPrinting,
  parseReviewAction,
  RESOLVER_VERSION,
  type EntityResolutionReviewAction,
  type EntityResolutionState,
  type EntityResolutionSubjectType,
  type ResolutionSignals,
  type ScoredCandidate,
} from "./identity.js";

export type PersistedResolution = {
  attempt: typeof entityResolutionAttempt.$inferSelect;
  candidates: Array<typeof entityResolutionCandidate.$inferSelect>;
};

export async function persistResolution(
  db: Database,
  input: {
    subjectType: EntityResolutionSubjectType;
    subjectId: string;
    mentionId?: string | null;
    status: EntityResolutionState;
    targetLayer: "printing" | "concept" | "generic_entity";
    chosenPrintingId: string | null;
    chosenConceptId: string | null;
    confidence: number | null;
    reviewState?: string;
    signals: ResolutionSignals;
    candidates: ScoredCandidate[];
    resolverVersion?: string;
  },
): Promise<PersistedResolution> {
  if (mayBindPrinting(input.status) && !input.chosenPrintingId) {
    throw new EntityResolutionError("exact/high_confidence resolution must bind a printing.");
  }
  if (!mayBindPrinting(input.status) && input.chosenPrintingId) {
    throw new EntityResolutionError("non-binding statuses cannot choose a printing.");
  }
  const attemptId = crypto.randomUUID();
  await db.insert(entityResolutionAttempt).values({
    id: attemptId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    mentionId: input.mentionId ?? (input.subjectType === "mention" ? input.subjectId : null),
    targetLayer: input.targetLayer,
    status: input.status,
    chosenPrintingId: input.chosenPrintingId,
    chosenConceptId: input.chosenConceptId,
    confidence: input.confidence == null ? null : input.confidence.toFixed(4),
    resolverVersion: input.resolverVersion ?? RESOLVER_VERSION,
    reviewState: input.reviewState ?? "none",
    inputSignals: input.signals as Record<string, unknown>,
  });
  const candidateRows = input.candidates.slice(0, 20).map((candidate, index) => ({
    id: crypto.randomUUID(),
    attemptId,
    printingId: candidate.printingId,
    conceptId: candidate.conceptId,
    score: candidate.score.toFixed(4),
    rank: index + 1,
    matchedAttributes: candidate.matched,
    conflictingAttributes: candidate.conflicting,
    evidence: candidate.evidence,
  }));
  if (candidateRows.length > 0) {
    await db.insert(entityResolutionCandidate).values(candidateRows);
  }
  return getResolutionAttempt(db, attemptId);
}

export async function getResolutionAttempt(
  db: Database,
  attemptId: string,
): Promise<PersistedResolution> {
  const [attempt] = await db
    .select()
    .from(entityResolutionAttempt)
    .where(eq(entityResolutionAttempt.id, attemptId))
    .limit(1);
  if (!attempt) {
    throw new EntityResolutionError("resolution attempt not found.");
  }
  const candidates = await db
    .select()
    .from(entityResolutionCandidate)
    .where(eq(entityResolutionCandidate.attemptId, attemptId));
  candidates.sort((a, b) => a.rank - b.rank);
  return { attempt, candidates };
}

export async function listResolutionHistory(
  db: Database,
  subjectType: EntityResolutionSubjectType,
  subjectId: string,
) {
  return db
    .select()
    .from(entityResolutionAttempt)
    .where(eq(entityResolutionAttempt.subjectId, subjectId))
    .orderBy(desc(entityResolutionAttempt.createdAt))
    .then((rows) => rows.filter((row) => row.subjectType === subjectType));
}

export async function getLatestResolution(
  db: Database,
  subjectType: EntityResolutionSubjectType,
  subjectId: string,
) {
  const history = await listResolutionHistory(db, subjectType, subjectId);
  const latest = history[0];
  if (!latest) {
    return null;
  }
  return getResolutionAttempt(db, latest.id);
}

export async function listResolutionCorrections(db: Database, sourceAttemptId: string) {
  return db
    .select()
    .from(entityResolutionCorrection)
    .where(eq(entityResolutionCorrection.sourceAttemptId, sourceAttemptId));
}

export async function getSourceMentionRecord(db: Database, mentionId: string) {
  const [mention] = await db
    .select()
    .from(sourceMention)
    .where(eq(sourceMention.id, mentionId))
    .limit(1);
  if (!mention) {
    return null;
  }
  const [content] = await db
    .select()
    .from(sourceContent)
    .where(eq(sourceContent.id, mention.contentId))
    .limit(1);
  return { mention, content: content ?? null };
}

export async function applyResolutionReview(
  db: Database,
  input: {
    sourceAttemptId: string;
    action: EntityResolutionReviewAction | string;
    candidateId?: string | null;
    printingId?: string | null;
    note?: string | null;
  },
): Promise<PersistedResolution> {
  const action = parseReviewAction(input.action) as EntityResolutionReviewAction;
  const source = await getResolutionAttempt(db, input.sourceAttemptId);
  let status: EntityResolutionState = "unresolved";
  let chosenPrintingId: string | null = null;
  let chosenConceptId = source.attempt.chosenConceptId;
  let reviewState = "unresolved_confirmed";
  let targetLayer: "printing" | "concept" | "generic_entity" = "concept";
  const evidence = ["manual_review"];

  if (action === "accept_candidate") {
    const candidate =
      source.candidates.find((row) => row.id === input.candidateId) ??
      source.candidates.find((row) => row.printingId === input.printingId);
    if (!candidate?.printingId) {
      throw new EntityResolutionError("accept_candidate requires a printing candidate.");
    }
    status = "exact";
    chosenPrintingId = candidate.printingId;
    chosenConceptId = candidate.conceptId;
    reviewState = "accepted";
    targetLayer = "printing";
    evidence.push("accept_candidate");
  } else if (action === "correct_mapping") {
    if (!input.printingId) {
      throw new EntityResolutionError("correct_mapping requires printing_id.");
    }
    status = "exact";
    chosenPrintingId = input.printingId;
    const candidate = source.candidates.find((row) => row.printingId === input.printingId);
    chosenConceptId = candidate?.conceptId ?? chosenConceptId;
    reviewState = "accepted";
    targetLayer = "printing";
    evidence.push("correct_mapping");
  } else if (action === "reject_candidate") {
    status = "unresolved";
    chosenPrintingId = null;
    reviewState = "rejected";
    targetLayer = "concept";
    evidence.push("reject_candidate");
  } else {
    status = "unresolved";
    chosenPrintingId = null;
    reviewState = "unresolved_confirmed";
    evidence.push("mark_unresolved");
  }

  const result = await persistResolution(db, {
    subjectType: source.attempt.subjectType as EntityResolutionSubjectType,
    subjectId: source.attempt.subjectId,
    mentionId: source.attempt.mentionId,
    status,
    targetLayer,
    chosenPrintingId,
    chosenConceptId,
    confidence: status === "exact" ? 1 : null,
    reviewState,
    signals: {
      ...(source.attempt.inputSignals as ResolutionSignals),
    },
    candidates: source.candidates.map((row) => ({
      printingId: row.printingId ?? "",
      conceptId: row.conceptId ?? "",
      score: Number(row.score),
      matched: row.matchedAttributes,
      conflicting: row.conflictingAttributes,
      evidence: [...row.evidence, ...evidence],
      nameSimilarity: 0,
    })).filter((row) => row.printingId),
    resolverVersion: RESOLVER_VERSION,
  });
  await db.insert(entityResolutionCorrection).values({
    id: crypto.randomUUID(),
    sourceAttemptId: input.sourceAttemptId,
    resultAttemptId: result.attempt.id,
    action,
    candidateId: input.candidateId ?? null,
    printingId: chosenPrintingId,
    note: input.note ?? null,
  });
  return result;
}
