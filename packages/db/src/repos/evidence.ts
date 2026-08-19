import { and, eq } from "drizzle-orm";
import { assertTenantContext } from "../rls.js";
import { evidenceReference } from "../schema/kernel.js";
import type { Database } from "../client.js";

export async function getEvidenceReference(
  scoped: Database,
  input: { organizationId: string; id: string },
) {
  await assertTenantContext(scoped);
  const [row] = await scoped
    .select()
    .from(evidenceReference)
    .where(
      and(
        eq(evidenceReference.organizationId, input.organizationId),
        eq(evidenceReference.id, input.id),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function insertEvidenceReference(
  scoped: Database,
  input: {
    id: string;
    organizationId: string;
    evidenceType: "source_event" | "observation" | "external";
    sourceEventId?: string | null;
    observationId?: string | null;
    externalReference?: string | null;
    capturedAt: Date;
    metadata?: Record<string, unknown>;
  },
) {
  await assertTenantContext(scoped);
  await scoped
    .insert(evidenceReference)
    .values({
      id: input.id,
      organizationId: input.organizationId,
      evidenceType: input.evidenceType,
      sourceEventId: input.sourceEventId,
      observationId: input.observationId,
      externalReference: input.externalReference,
      capturedAt: input.capturedAt,
      metadata: input.metadata ?? {},
    })
    .onConflictDoNothing();
  return getEvidenceReference(scoped, { organizationId: input.organizationId, id: input.id });
}

export async function listEvidenceReferences(
  scoped: Database,
  organizationId: string,
) {
  await assertTenantContext(scoped);
  return scoped
    .select()
    .from(evidenceReference)
    .where(eq(evidenceReference.organizationId, organizationId));
}
