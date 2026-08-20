import { eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { contentClaim, contentDraft, contentEvidencePackage, contentValidation } from "../schema/content.js";
import { CONTENT_TEMPLATES, CONTENT_VALIDATOR_VERSION, MIN_INDEXABLE_CHARS, type ContentOutputType } from "./catalog.js";

export async function validateDraft(
  db: Database,
  input: { draftId: string; outputType: ContentOutputType },
) {
  const [draft] = await db.select().from(contentDraft).where(eq(contentDraft.id, input.draftId)).limit(1);
  if (!draft) {
    throw new Error("Draft not found.");
  }
  const [evidence] = await db
    .select()
    .from(contentEvidencePackage)
    .where(eq(contentEvidencePackage.id, draft.evidenceId))
    .limit(1);
  if (!evidence) {
    throw new Error("Evidence package not found.");
  }
  const claims = await db.select().from(contentClaim).where(eq(contentClaim.draftId, draft.id));
  const sourceIds = new Set(evidence.sources.map((row) => row.id));
  const failures: string[] = [];
  const template = CONTENT_TEMPLATES[input.outputType];
  const identity = evidence.identity as Record<string, unknown>;
  const identityLanguage = String(identity.languageCode ?? "");

  if (draft.generatorVersion.trim() === "") {
    failures.push("model_version_missing");
  }
  if (!evidence.thin && draft.bodyText.length < template.minChars) {
    failures.push("min_substance");
  }
  if (evidence.thin && draft.bodyText.length < 40) {
    failures.push("stub_too_short");
  }
  if (identityLanguage && identityLanguage !== evidence.languageCode) {
    failures.push("language_mismatch");
  }
  if (!evidence.comparative) {
    const key = String(identity.canonicalPrintingKey ?? "");
    if (key && evidence.languageCode && !key.includes(evidence.languageCode)) {
      failures.push("cross_language_merge");
    }
  }
  for (const claim of claims) {
    if (!sourceIds.has(claim.sourceId)) {
      failures.push(`unresolved_claim:${claim.claimKey}`);
    }
  }
  if (!evidence.thin && claims.length === 0) {
    failures.push("numeric_claims_missing");
  }
  if (draft.bodyHtml.includes("<script")) {
    failures.push("unsafe_html");
  }
  if (!evidence.thin && input.outputType === "card_analysis" && draft.bodyText.length < MIN_INDEXABLE_CHARS) {
    failures.push("min_substance");
  }

  const passed = failures.length === 0;
  const [row] = await db
    .insert(contentValidation)
    .values({
      id: crypto.randomUUID(),
      draftId: draft.id,
      passed,
      failures,
      validatorVersion: CONTENT_VALIDATOR_VERSION,
    })
    .returning();
  return row!;
}
