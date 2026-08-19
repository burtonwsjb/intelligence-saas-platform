import { createHash } from "node:crypto";
import { insertEntity, insertEntityIdentifier } from "../repos/entity.js";
import type { Database } from "../client.js";
import {
  kernelCanonicalKeyForPrinting,
  TCG_ENTITY_TYPE,
  TCG_PRINTING_IDENTIFIER_TYPE,
  TCG_SOURCE_NAMESPACE,
} from "./identity.js";

export async function ensureTcgPrintingEntity(
  scoped: Database,
  input: {
    organizationId: string;
    printing: { id: string; canonicalPrintingKey: string; collectorNumber: string };
  },
) {
  const canonicalKey = kernelCanonicalKeyForPrinting(input.printing.canonicalPrintingKey);
  const entityId = `ent_${createHash("sha256")
    .update(`${input.organizationId}|${canonicalKey}`)
    .digest("hex")
    .slice(0, 32)}`;
  const entity = await insertEntity(scoped, {
    id: entityId,
    organizationId: input.organizationId,
    entityType: TCG_ENTITY_TYPE,
    canonicalKey,
    displayName: input.printing.collectorNumber,
    attributes: { printing_id: input.printing.id },
  });
  await insertEntityIdentifier(scoped, {
    id: `eid_${createHash("sha256")
      .update(`${input.organizationId}|${canonicalKey}`)
      .digest("hex")
      .slice(0, 32)}`,
    organizationId: input.organizationId,
    entityId: entity!.id,
    sourceNamespace: TCG_SOURCE_NAMESPACE,
    identifierType: TCG_PRINTING_IDENTIFIER_TYPE,
    identifierValue: input.printing.canonicalPrintingKey,
    normalizedValue: input.printing.canonicalPrintingKey,
  });
  return entity!;
}
