import { eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { contentDraft, contentEvidencePackage, contentPublication, contentValidation } from "../schema/content.js";
import { canonicalPrintingUrl } from "./catalog.js";

export class ContentApprovalError extends Error {
  constructor(message = "Content cannot be approved.") {
    super(message);
    this.name = "ContentApprovalError";
  }
}

export async function approveDraft(
  db: Database,
  input: { draftId: string; approvedBy?: string | null },
) {
  const [draft] = await db.select().from(contentDraft).where(eq(contentDraft.id, input.draftId)).limit(1);
  if (!draft) {
    throw new ContentApprovalError("Draft not found.");
  }
  const [validation] = await db
    .select()
    .from(contentValidation)
    .where(eq(contentValidation.draftId, draft.id))
    .limit(1);
  if (!validation?.passed) {
    throw new ContentApprovalError("Validation must pass before approval.");
  }
  const [evidence] = await db
    .select()
    .from(contentEvidencePackage)
    .where(eq(contentEvidencePackage.id, draft.evidenceId))
    .limit(1);
  if (!evidence) {
    throw new ContentApprovalError("Evidence package not found.");
  }
  const identity = evidence.identity as Record<string, unknown>;
  const preferred = canonicalPrintingUrl({
    gameKey: String(identity.gameKey ?? "unknown"),
    languageCode: evidence.languageCode,
    canonicalPrintingKey: String(identity.canonicalPrintingKey ?? draft.id),
  });
  const existing = await db
    .select()
    .from(contentPublication)
    .where(eq(contentPublication.canonicalUrl, preferred));
  const duplicate = existing.some((row) => row.indexable);
  const indexable = !evidence.thin && !duplicate && evidence.recommendation !== "insufficient_data";
  const canonicalUrl = indexable ? preferred : `${preferred}/stub/${draft.id}`;
  const [row] = await db
    .insert(contentPublication)
    .values({
      id: crypto.randomUUID(),
      draftId: draft.id,
      candidateId: draft.candidateId,
      canonicalUrl,
      robots: indexable ? "index" : "noindex",
      indexable,
      approvedBy: input.approvedBy ?? "operator",
      status: "approved",
    })
    .returning();
  return row!;
}

export async function getPublicationByPath(db: Database, pathname: string) {
  const [row] = await db
    .select()
    .from(contentPublication)
    .where(eq(contentPublication.canonicalUrl, pathname))
    .limit(1);
  if (!row) {
    return null;
  }
  const [draft] = await db.select().from(contentDraft).where(eq(contentDraft.id, row.draftId)).limit(1);
  return { publication: row, draft: draft ?? null };
}
