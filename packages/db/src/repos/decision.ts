import { and, eq } from "drizzle-orm";
import { assertTenantContext } from "../rls.js";
import { decisionEvidence, decisionRecord } from "../schema/kernel.js";
import type { Database } from "../client.js";

export async function getDecisionRecord(
  scoped: Database,
  input: { organizationId: string; id: string },
) {
  await assertTenantContext(scoped);
  const [row] = await scoped
    .select()
    .from(decisionRecord)
    .where(
      and(eq(decisionRecord.organizationId, input.organizationId), eq(decisionRecord.id, input.id)),
    )
    .limit(1);
  return row ?? null;
}

export async function insertDecisionRecord(
  scoped: Database,
  input: {
    id: string;
    organizationId: string;
    entityId: string;
    decisionType: string;
    status?: "draft" | "finalized";
    result?: Record<string, unknown>;
    confidence: string;
    policyKey: string;
    policyVersion: string;
    featureSnapshotId?: string | null;
    expiresAt?: Date | null;
  },
) {
  await assertTenantContext(scoped);
  await scoped.insert(decisionRecord).values({
    id: input.id,
    organizationId: input.organizationId,
    entityId: input.entityId,
    decisionType: input.decisionType,
    status: input.status ?? "draft",
    result: input.result ?? {},
    confidence: input.confidence,
    policyKey: input.policyKey,
    policyVersion: input.policyVersion,
    featureSnapshotId: input.featureSnapshotId,
    expiresAt: input.expiresAt,
    finalizedAt: input.status === "finalized" ? new Date() : null,
  });
  return getDecisionRecord(scoped, { organizationId: input.organizationId, id: input.id });
}

export async function finalizeDecisionRecord(
  scoped: Database,
  input: { organizationId: string; id: string },
) {
  await assertTenantContext(scoped);
  const updated = await scoped
    .update(decisionRecord)
    .set({ status: "finalized", finalizedAt: new Date() })
    .where(
      and(eq(decisionRecord.organizationId, input.organizationId), eq(decisionRecord.id, input.id)),
    )
    .returning({ id: decisionRecord.id });
  return updated.length;
}

export async function insertDecisionEvidence(
  scoped: Database,
  input: {
    id: string;
    organizationId: string;
    decisionId: string;
    signalId?: string | null;
    evidenceReferenceId?: string | null;
    role?: string | null;
  },
) {
  await assertTenantContext(scoped);
  await scoped.insert(decisionEvidence).values({
    id: input.id,
    organizationId: input.organizationId,
    decisionId: input.decisionId,
    signalId: input.signalId,
    evidenceReferenceId: input.evidenceReferenceId,
    role: input.role,
  });
}

export async function listDecisionRecords(
  scoped: Database,
  organizationId: string,
) {
  await assertTenantContext(scoped);
  return scoped
    .select()
    .from(decisionRecord)
    .where(eq(decisionRecord.organizationId, organizationId))
    .orderBy(decisionRecord.createdAt);
}

export async function listDecisionEvidence(
  scoped: Database,
  input: { organizationId: string; decisionId: string },
) {
  await assertTenantContext(scoped);
  return scoped
    .select()
    .from(decisionEvidence)
    .where(
      and(
        eq(decisionEvidence.organizationId, input.organizationId),
        eq(decisionEvidence.decisionId, input.decisionId),
      ),
    );
}
