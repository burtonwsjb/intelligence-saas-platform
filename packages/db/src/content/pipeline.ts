import type { Database } from "../client.js";
import { tenantContentReport } from "../schema/content.js";
import { assertTenantContext } from "../rls.js";
import { type ContentOutputType } from "./catalog.js";
import {
  buildEvidenceForPrinting,
  persistEvidencePackage,
  proposeContentCandidate,
  type EvidenceInput,
} from "./evidence.js";
import { generateDraft, type ContentGenerator } from "./generate.js";
import { validateDraft } from "./validate.js";
import { approveDraft } from "./publish.js";

export async function runContentPipeline(
  db: Database,
  input: {
    outputType: ContentOutputType;
    printingId?: string;
    languageCode?: string;
    asOf?: Date;
    evidence?: EvidenceInput;
    generator?: ContentGenerator;
    approve?: boolean;
    approvedBy?: string;
    unsafeTitleSuffix?: string;
  },
) {
  const gathered =
    input.evidence ??
    (input.printingId ? await buildEvidenceForPrinting(db, { printingId: input.printingId, asOf: input.asOf }) : null);
  if (!gathered) {
    throw new Error("Unable to assemble an evidence package.");
  }
  const candidate = await proposeContentCandidate(db, {
    outputType: input.outputType,
    printingId: gathered.printingId,
    languageCode: input.languageCode ?? gathered.languageCode,
    comparative: gathered.comparative,
    asOf: gathered.asOf,
  });
  const evidence = await persistEvidencePackage(db, {
    candidateId: candidate.id,
    outputType: input.outputType,
    evidence: gathered,
  });
  const draft = await generateDraft(db, {
    candidateId: candidate.id,
    evidenceId: evidence.id,
    outputType: input.outputType,
    generator: input.generator,
    unsafeTitleSuffix: input.unsafeTitleSuffix,
  });
  const validation = await validateDraft(db, { draftId: draft.id, outputType: input.outputType });
  const publication =
    input.approve && validation.passed
      ? await approveDraft(db, { draftId: draft.id, approvedBy: input.approvedBy })
      : null;
  return { candidate, evidence, draft, validation, publication };
}

export async function createTenantReport(
  scoped: Database,
  input: {
    organizationId: string;
    title: string;
    bodyText: string;
    holdings?: unknown[];
  },
) {
  await assertTenantContext(scoped);
  const [row] = await scoped
    .insert(tenantContentReport)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      title: input.title.slice(0, 180),
      bodyText: input.bodyText.slice(0, 8000),
      holdings: input.holdings ?? [],
      publicSeo: false,
    })
    .returning();
  return row!;
}
