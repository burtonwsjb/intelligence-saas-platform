import type { Database } from "../client.js";
import { contentClaim, contentDraft, contentEvidencePackage } from "../schema/content.js";
import { eq } from "drizzle-orm";
import {
  CONTENT_TEMPLATES,
  FIXTURE_GENERATOR_KEY,
  LOCAL_GENERATOR_KEY,
  LOCAL_GENERATOR_VERSION,
  MIN_INDEXABLE_CHARS,
  escapeContentHtml,
  type ContentOutputType,
} from "./catalog.js";
import { MissingEvidenceError } from "./evidence.js";

export type GeneratedClaim = {
  claimKey: string;
  numericValue: string;
  sourceType: string;
  sourceId: string;
};

export type GeneratedContent = {
  title: string;
  bodyText: string;
  bodyHtml: string;
  claims: GeneratedClaim[];
  generatorKey: string;
  generatorVersion: string;
};

export type ContentGenerator = {
  generate(input: {
    outputType: ContentOutputType;
    evidence: typeof contentEvidencePackage.$inferSelect;
    unsafeTitleSuffix?: string;
  }): Promise<GeneratedContent>;
  healthCheck(): Promise<{ ok: boolean }>;
};

function padSubstance(text: string, minChars: number): string {
  if (text.length >= minChars) {
    return text;
  }
  const note =
    " This analysis is bound to the cited as-of snapshot, language, and variant. It does not merge cross-language books.";
  return `${text}${note.repeat(Math.ceil((minChars - text.length) / note.length))}`;
}

export class LocalContentGenerator implements ContentGenerator {
  async healthCheck() {
    return { ok: true };
  }

  async generate(input: {
    outputType: ContentOutputType;
    evidence: typeof contentEvidencePackage.$inferSelect;
    unsafeTitleSuffix?: string;
  }): Promise<GeneratedContent> {
    const identity = input.evidence.identity as Record<string, unknown>;
    const name = String(identity.cardName ?? "Unknown card");
    const setName = String(identity.setName ?? "Unknown set");
    const collector = String(identity.collectorNumber ?? "?");
    const language = input.evidence.languageCode;
    const variant = String(identity.variantKey ?? "unknown");
    const suffix = input.unsafeTitleSuffix ?? "";
    const title = `${name} · ${setName} · #${collector} · ${language} · ${variant}${suffix}`;
    const claims: GeneratedClaim[] = [];
    const snapshot = input.evidence.sources.find((row) => row.type === "market_snapshot");
    const score = input.evidence.sources.find((row) => row.type === "score_snapshot");
    const signals = Array.isArray(input.evidence.signals) ? input.evidence.signals : [];
    const opportunity = signals.find((row) => {
      return Boolean(row && typeof row === "object" && "key" in row && (row as { key: string }).key === "opportunity");
    }) as { magnitude?: number } | undefined;
    if (snapshot) {
      claims.push({
        claimKey: "opportunity_score",
        numericValue: String(opportunity?.magnitude ?? input.evidence.sources.length),
        sourceType: snapshot.type,
        sourceId: score?.id ?? snapshot.id,
      });
    }
    if (score) {
      claims.push({
        claimKey: "evidence_sources",
        numericValue: String(input.evidence.sources.length),
        sourceType: score.type,
        sourceId: score.id,
      });
    }
    const stub = input.evidence.thin;
    const core = [
      `As of ${input.evidence.asOf.toISOString()}, this ${input.outputType.replaceAll("_", " ")} covers ${title}.`,
      `Recommendation: ${input.evidence.recommendation}.`,
      `Cited sources: ${input.evidence.sources.map((row) => `${row.type}:${row.id}`).join(", ") || "none"}.`,
      `What would falsify this: ${input.evidence.falsifiers.join(" ")}`,
      stub
        ? "Evidence is thin. This page is a non-indexable stub until additional observations exist."
        : "Evidence cites market observations, scores, and creator calls when present.",
    ].join(" ");
    const min = stub ? 80 : CONTENT_TEMPLATES[input.outputType].minChars;
    const bodyText = padSubstance(core, stub ? 80 : Math.max(min, MIN_INDEXABLE_CHARS));
    return {
      title,
      bodyText,
      bodyHtml: `<p>${escapeContentHtml(bodyText)}</p>`,
      claims,
      generatorKey: LOCAL_GENERATOR_KEY,
      generatorVersion: LOCAL_GENERATOR_VERSION,
    };
  }
}

export class FixtureContentGenerator extends LocalContentGenerator {
  override async generate(input: Parameters<LocalContentGenerator["generate"]>[0]) {
    const generated = await super.generate(input);
    return { ...generated, generatorKey: FIXTURE_GENERATOR_KEY };
  }
}

export class UnconfiguredLlmContentGenerator implements ContentGenerator {
  async healthCheck() {
    return { ok: false };
  }

  async generate(): Promise<GeneratedContent> {
    throw new Error("LLM content generation is not configured. Use the local or fixture generator.");
  }
}

export async function generateDraft(
  db: Database,
  input: {
    candidateId: string;
    evidenceId: string;
    outputType: ContentOutputType;
    generator?: ContentGenerator;
    unsafeTitleSuffix?: string;
  },
) {
  const [evidence] = await db
    .select()
    .from(contentEvidencePackage)
    .where(eq(contentEvidencePackage.id, input.evidenceId))
    .limit(1);
  if (!evidence || evidence.candidateId !== input.candidateId) {
    throw new MissingEvidenceError();
  }
  if (evidence.thin && !CONTENT_TEMPLATES[input.outputType].allowThinStub) {
    throw new MissingEvidenceError("Thin evidence cannot generate this template.");
  }
  const generator = input.generator ?? new LocalContentGenerator();
  const generated = await generator.generate({
    outputType: input.outputType,
    evidence,
    unsafeTitleSuffix: input.unsafeTitleSuffix,
  });
  const [draft] = await db
    .insert(contentDraft)
    .values({
      id: crypto.randomUUID(),
      candidateId: input.candidateId,
      evidenceId: evidence.id,
      generatorKey: generated.generatorKey,
      generatorVersion: generated.generatorVersion,
      title: generated.title,
      bodyText: generated.bodyText,
      bodyHtml: generated.bodyHtml,
    })
    .returning();
  for (const claim of generated.claims) {
    await db.insert(contentClaim).values({
      id: crypto.randomUUID(),
      draftId: draft!.id,
      claimKey: claim.claimKey,
      numericValue: claim.numericValue,
      sourceType: claim.sourceType,
      sourceId: claim.sourceId,
    });
  }
  return draft!;
}
