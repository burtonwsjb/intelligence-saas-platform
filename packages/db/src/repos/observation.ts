import { and, eq, gte, lte } from "drizzle-orm";
import { assertTenantContext } from "../rls.js";
import { observation, observationMetric } from "../schema/kernel.js";
import type { Database } from "../client.js";

export async function getObservation(
  scoped: Database,
  input: { organizationId: string; id: string },
) {
  await assertTenantContext(scoped);
  const [row] = await scoped
    .select()
    .from(observation)
    .where(and(eq(observation.organizationId, input.organizationId), eq(observation.id, input.id)))
    .limit(1);
  return row ?? null;
}

export async function getObservationBySourceEvent(
  scoped: Database,
  input: { organizationId: string; sourceEventId: string },
) {
  await assertTenantContext(scoped);
  const [row] = await scoped
    .select()
    .from(observation)
    .where(
      and(
        eq(observation.organizationId, input.organizationId),
        eq(observation.sourceEventId, input.sourceEventId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function insertObservation(
  scoped: Database,
  input: {
    id: string;
    organizationId: string;
    entityId?: string | null;
    sourceEventId: string;
    sourceNamespace: string;
    observationType: string;
    observedAt: Date;
    receivedAt: Date;
    confidence?: string | null;
    qualityFlag?: string | null;
    attributes?: Record<string, unknown>;
    supersedesObservationId?: string | null;
  },
) {
  await assertTenantContext(scoped);
  await scoped
    .insert(observation)
    .values({
      id: input.id,
      organizationId: input.organizationId,
      entityId: input.entityId,
      sourceEventId: input.sourceEventId,
      sourceNamespace: input.sourceNamespace,
      observationType: input.observationType,
      observedAt: input.observedAt,
      receivedAt: input.receivedAt,
      confidence: input.confidence,
      qualityFlag: input.qualityFlag,
      attributes: input.attributes ?? {},
      supersedesObservationId: input.supersedesObservationId,
    })
    .onConflictDoNothing();
  return getObservation(scoped, { organizationId: input.organizationId, id: input.id });
}

export async function insertObservationMetric(
  scoped: Database,
  input: {
    id: string;
    organizationId: string;
    observationId: string;
    metricKey: string;
    numericValue?: string | null;
    textValue?: string | null;
    unit?: string | null;
    dimension?: Record<string, unknown>;
  },
) {
  await assertTenantContext(scoped);
  await scoped
    .insert(observationMetric)
    .values({
      id: input.id,
      organizationId: input.organizationId,
      observationId: input.observationId,
      metricKey: input.metricKey,
      numericValue: input.numericValue,
      textValue: input.textValue,
      unit: input.unit,
      dimension: input.dimension ?? {},
    })
    .onConflictDoNothing();
}

export async function listObservationMetrics(
  scoped: Database,
  input: { organizationId: string; observationId: string },
) {
  await assertTenantContext(scoped);
  return scoped
    .select()
    .from(observationMetric)
    .where(
      and(
        eq(observationMetric.organizationId, input.organizationId),
        eq(observationMetric.observationId, input.observationId),
      ),
    );
}

export async function listObservationsInRange(
  scoped: Database,
  input: {
    organizationId: string;
    entityId?: string;
    from: Date;
    to: Date;
  },
) {
  await assertTenantContext(scoped);
  const filters = [
    eq(observation.organizationId, input.organizationId),
    gte(observation.observedAt, input.from),
    lte(observation.observedAt, input.to),
  ];
  if (input.entityId) {
    filters.push(eq(observation.entityId, input.entityId));
  }
  return scoped
    .select()
    .from(observation)
    .where(and(...filters))
    .orderBy(observation.observedAt);
}

export async function listObservationMetricsInRange(
  scoped: Database,
  input: {
    organizationId: string;
    metricKey?: string;
    from: Date;
    to: Date;
  },
) {
  await assertTenantContext(scoped);
  const rows = await scoped
    .select({
      metric: observationMetric,
      observedAt: observation.observedAt,
    })
    .from(observationMetric)
    .innerJoin(
      observation,
      and(
        eq(observation.id, observationMetric.observationId),
        eq(observation.organizationId, observationMetric.organizationId),
      ),
    )
    .where(
      and(
        eq(observationMetric.organizationId, input.organizationId),
        gte(observation.observedAt, input.from),
        lte(observation.observedAt, input.to),
        ...(input.metricKey ? [eq(observationMetric.metricKey, input.metricKey)] : []),
      ),
    )
    .orderBy(observation.observedAt);
  return rows;
}
