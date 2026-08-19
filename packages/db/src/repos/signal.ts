import { and, eq, gte, lte } from "drizzle-orm";
import { assertTenantContext } from "../rls.js";
import { featureSnapshot, signal, signalEvidence } from "../schema/kernel.js";
import type { Database } from "../client.js";

export async function getFeatureSnapshot(
  scoped: Database,
  input: { organizationId: string; id: string },
) {
  await assertTenantContext(scoped);
  const [row] = await scoped
    .select()
    .from(featureSnapshot)
    .where(
      and(
        eq(featureSnapshot.organizationId, input.organizationId),
        eq(featureSnapshot.id, input.id),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function insertFeatureSnapshot(
  scoped: Database,
  input: {
    id: string;
    organizationId: string;
    entityId: string;
    featureSetKey: string;
    featureSetVersion: string;
    features: Record<string, unknown>;
    fingerprint: string;
    asOf: Date;
  },
) {
  await assertTenantContext(scoped);
  await scoped
    .insert(featureSnapshot)
    .values({
      id: input.id,
      organizationId: input.organizationId,
      entityId: input.entityId,
      featureSetKey: input.featureSetKey,
      featureSetVersion: input.featureSetVersion,
      features: input.features,
      fingerprint: input.fingerprint,
      asOf: input.asOf,
    })
    .onConflictDoNothing();
  return getFeatureSnapshot(scoped, { organizationId: input.organizationId, id: input.id });
}

export async function listFeatureSnapshotsInRange(
  scoped: Database,
  input: { organizationId: string; entityId?: string; from: Date; to: Date },
) {
  await assertTenantContext(scoped);
  const filters = [
    eq(featureSnapshot.organizationId, input.organizationId),
    gte(featureSnapshot.asOf, input.from),
    lte(featureSnapshot.asOf, input.to),
  ];
  if (input.entityId) {
    filters.push(eq(featureSnapshot.entityId, input.entityId));
  }
  return scoped
    .select()
    .from(featureSnapshot)
    .where(and(...filters))
    .orderBy(featureSnapshot.asOf);
}

export async function getSignal(
  scoped: Database,
  input: { organizationId: string; id: string },
) {
  await assertTenantContext(scoped);
  const [row] = await scoped
    .select()
    .from(signal)
    .where(and(eq(signal.organizationId, input.organizationId), eq(signal.id, input.id)))
    .limit(1);
  return row ?? null;
}

export async function insertSignal(
  scoped: Database,
  input: {
    id: string;
    organizationId: string;
    entityId: string;
    signalType: string;
    direction: "up" | "down" | "flat" | "unknown";
    magnitude?: string | null;
    score?: string | null;
    confidence: string;
    validFrom: Date;
    validUntil?: Date | null;
    algorithmKey: string;
    algorithmVersion: string;
    featureSnapshotId?: string | null;
  },
) {
  await assertTenantContext(scoped);
  await scoped
    .insert(signal)
    .values({
      id: input.id,
      organizationId: input.organizationId,
      entityId: input.entityId,
      signalType: input.signalType,
      direction: input.direction,
      magnitude: input.magnitude,
      score: input.score,
      confidence: input.confidence,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      algorithmKey: input.algorithmKey,
      algorithmVersion: input.algorithmVersion,
      featureSnapshotId: input.featureSnapshotId,
    })
    .onConflictDoNothing();
  return getSignal(scoped, { organizationId: input.organizationId, id: input.id });
}

export async function insertSignalEvidence(
  scoped: Database,
  input: {
    id: string;
    organizationId: string;
    signalId: string;
    evidenceReferenceId: string;
    observationId?: string | null;
    weight?: string | null;
    role?: string | null;
  },
) {
  await assertTenantContext(scoped);
  await scoped
    .insert(signalEvidence)
    .values({
      id: input.id,
      organizationId: input.organizationId,
      signalId: input.signalId,
      evidenceReferenceId: input.evidenceReferenceId,
      observationId: input.observationId,
      weight: input.weight,
      role: input.role,
    })
    .onConflictDoNothing();
}

export async function listSignalEvidence(
  scoped: Database,
  input: { organizationId: string; signalId: string },
) {
  await assertTenantContext(scoped);
  return scoped
    .select()
    .from(signalEvidence)
    .where(
      and(
        eq(signalEvidence.organizationId, input.organizationId),
        eq(signalEvidence.signalId, input.signalId),
      ),
    );
}

export async function listSignalsInRange(
  scoped: Database,
  input: { organizationId: string; entityId?: string; from: Date; to: Date },
) {
  await assertTenantContext(scoped);
  const filters = [
    eq(signal.organizationId, input.organizationId),
    gte(signal.validFrom, input.from),
    lte(signal.validFrom, input.to),
  ];
  if (input.entityId) {
    filters.push(eq(signal.entityId, input.entityId));
  }
  return scoped.select().from(signal).where(and(...filters)).orderBy(signal.validFrom);
}
