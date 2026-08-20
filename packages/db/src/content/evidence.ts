import type { Database } from "../client.js";
import { contentCandidate, contentEvidencePackage } from "../schema/content.js";
import { getPrintingWorkspace } from "../dashboard/queries.js";
import {
  CONTENT_EVIDENCE_VERSION,
  CONTENT_TEMPLATES,
  type ContentOutputType,
} from "./catalog.js";

export class MissingEvidenceError extends Error {
  constructor(message = "Content generation requires an evidence package.") {
    super(message);
    this.name = "MissingEvidenceError";
  }
}

export type EvidenceSource = { type: string; id: string };

export type EvidenceInput = {
  printingId: string;
  languageCode: string;
  comparative?: boolean;
  asOf: Date;
  recommendation: string;
  snapshotId?: string | null;
  scoreId?: string | null;
  predictionId?: string | null;
  signals: unknown[];
  sources: EvidenceSource[];
  falsifiers: string[];
  identity: Record<string, unknown>;
};

export function evidenceIsThin(input: EvidenceInput, outputType: ContentOutputType): boolean {
  const template = CONTENT_TEMPLATES[outputType];
  if (!input.identity.canonicalPrintingKey || !input.identity.languageCode) {
    return true;
  }
  if (!input.snapshotId && !input.scoreId) {
    return true;
  }
  if (input.recommendation === "insufficient_data") {
    return true;
  }
  if (input.sources.length < template.minSources) {
    return true;
  }
  if (input.signals.length < template.minSignals) {
    return true;
  }
  if (input.falsifiers.length === 0) {
    return true;
  }
  return false;
}

export async function proposeContentCandidate(
  db: Database,
  input: {
    outputType: ContentOutputType;
    printingId?: string | null;
    languageCode: string;
    comparative?: boolean;
    asOf: Date;
  },
) {
  const [row] = await db
    .insert(contentCandidate)
    .values({
      id: crypto.randomUUID(),
      outputType: input.outputType,
      printingId: input.printingId ?? null,
      languageCode: input.languageCode,
      comparative: input.comparative ?? false,
      asOf: input.asOf,
      status: "proposed",
    })
    .returning();
  return row!;
}

export async function persistEvidencePackage(
  db: Database,
  input: {
    candidateId: string;
    outputType: ContentOutputType;
    evidence: EvidenceInput;
  },
) {
  const thin = evidenceIsThin(input.evidence, input.outputType);
  const [row] = await db
    .insert(contentEvidencePackage)
    .values({
      id: crypto.randomUUID(),
      candidateId: input.candidateId,
      printingId: input.evidence.printingId,
      languageCode: input.evidence.languageCode,
      asOf: input.evidence.asOf,
      recommendation: input.evidence.recommendation,
      thin,
      comparative: input.evidence.comparative ?? false,
      snapshotId: input.evidence.snapshotId ?? null,
      scoreId: input.evidence.scoreId ?? null,
      predictionId: input.evidence.predictionId ?? null,
      signals: input.evidence.signals,
      sources: input.evidence.sources,
      falsifiers: input.evidence.falsifiers,
      identity: input.evidence.identity,
      evidenceVersion: CONTENT_EVIDENCE_VERSION,
    })
    .returning();
  return row!;
}

export async function buildEvidenceForPrinting(
  db: Database,
  input: { printingId: string; asOf?: Date },
): Promise<EvidenceInput | null> {
  const workspace = await getPrintingWorkspace(db, input.printingId);
  if (!workspace) {
    return null;
  }
  const asOf = input.asOf ?? workspace.score?.asOf ?? workspace.latestSold?.observedAt ?? new Date();
  const sources: EvidenceSource[] = [];
  if (workspace.latestSold) {
    sources.push({ type: "market_snapshot", id: workspace.latestSold.id });
  }
  if (workspace.score) {
    sources.push({ type: "score_snapshot", id: workspace.score.id });
  }
  if (workspace.features) {
    sources.push({ type: "feature_snapshot", id: workspace.features.id });
  }
  for (const call of workspace.calls.slice(0, 3)) {
    sources.push({ type: "creator_call", id: call.id });
  }
  const signals = [
    workspace.features
      ? { key: "market_features", magnitude: workspace.features.sampleSize, asOf: workspace.features.asOf.toISOString() }
      : null,
    workspace.score
      ? { key: "opportunity", magnitude: Number(workspace.score.opportunityScore) }
      : null,
    workspace.spread?.spread_abs != null ? { key: "spread_abs", magnitude: workspace.spread.spread_abs } : null,
  ].filter(Boolean);
  const published = workspace.predictions.find((row) => row.visibility === "published") ?? null;
  return {
    printingId: workspace.identity.printingId,
    languageCode: workspace.identity.languageCode,
    asOf,
    recommendation: workspace.score?.recommendation ?? "insufficient_data",
    snapshotId: workspace.latestSold?.id ?? workspace.reference?.id ?? null,
    scoreId: workspace.score?.id ?? null,
    predictionId: published?.id ?? null,
    signals,
    sources,
    falsifiers: [
      "A later sold print in this exact language and variant that reverses the cited move would weaken this analysis.",
    ],
    identity: { ...workspace.identity },
  };
}
