import { and, eq } from "drizzle-orm";
import { assertTenantContext } from "../rls.js";
import { IdentifierCollisionError } from "../kernel-errors.js";
import { entity, entityIdentifier } from "../schema/kernel.js";
import type { Database } from "../client.js";

export async function getEntity(
  scoped: Database,
  input: { organizationId: string; id: string },
) {
  await assertTenantContext(scoped);
  const [row] = await scoped
    .select()
    .from(entity)
    .where(and(eq(entity.organizationId, input.organizationId), eq(entity.id, input.id)))
    .limit(1);
  return row ?? null;
}

export async function findEntityByCanonical(
  scoped: Database,
  input: { organizationId: string; canonicalKey: string },
) {
  await assertTenantContext(scoped);
  const [row] = await scoped
    .select()
    .from(entity)
    .where(
      and(
        eq(entity.organizationId, input.organizationId),
        eq(entity.canonicalKey, input.canonicalKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function insertEntity(
  scoped: Database,
  input: {
    id: string;
    organizationId: string;
    entityType: string;
    canonicalKey: string;
    displayName?: string | null;
    attributes?: Record<string, unknown>;
  },
) {
  await assertTenantContext(scoped);
  await scoped
    .insert(entity)
    .values({
      id: input.id,
      organizationId: input.organizationId,
      entityType: input.entityType,
      canonicalKey: input.canonicalKey,
      displayName: input.displayName,
      attributes: input.attributes ?? {},
    })
    .onConflictDoNothing();
  return findEntityByCanonical(scoped, {
    organizationId: input.organizationId,
    canonicalKey: input.canonicalKey,
  });
}

export async function listEntities(
  scoped: Database,
  organizationId: string,
) {
  await assertTenantContext(scoped);
  return scoped.select().from(entity).where(eq(entity.organizationId, organizationId));
}

export async function findEntityIdentifier(
  scoped: Database,
  input: {
    organizationId: string;
    sourceNamespace: string;
    identifierType: string;
    normalizedValue: string;
  },
) {
  await assertTenantContext(scoped);
  const [row] = await scoped
    .select()
    .from(entityIdentifier)
    .where(
      and(
        eq(entityIdentifier.organizationId, input.organizationId),
        eq(entityIdentifier.sourceNamespace, input.sourceNamespace),
        eq(entityIdentifier.identifierType, input.identifierType),
        eq(entityIdentifier.normalizedValue, input.normalizedValue),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function insertEntityIdentifier(
  scoped: Database,
  input: {
    id: string;
    organizationId: string;
    entityId: string;
    sourceNamespace: string;
    identifierType: string;
    identifierValue: string;
    normalizedValue: string;
  },
) {
  await assertTenantContext(scoped);
  const existing = await findEntityIdentifier(scoped, input);
  if (existing) {
    if (existing.entityId !== input.entityId) {
      throw new IdentifierCollisionError();
    }
    return existing;
  }
  try {
    await scoped.insert(entityIdentifier).values({
      id: input.id,
      organizationId: input.organizationId,
      entityId: input.entityId,
      sourceNamespace: input.sourceNamespace,
      identifierType: input.identifierType,
      identifierValue: input.identifierValue,
      normalizedValue: input.normalizedValue,
    });
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (code !== "23505") {
      throw error;
    }
    const raced = await findEntityIdentifier(scoped, input);
    if (raced && raced.entityId !== input.entityId) {
      throw new IdentifierCollisionError();
    }
    return raced;
  }
  return findEntityIdentifier(scoped, input);
}

export async function listEntityIdentifiers(
  scoped: Database,
  organizationId: string,
) {
  await assertTenantContext(scoped);
  return scoped
    .select()
    .from(entityIdentifier)
    .where(eq(entityIdentifier.organizationId, organizationId));
}
