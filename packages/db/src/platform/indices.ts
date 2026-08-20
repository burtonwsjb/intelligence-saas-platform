import type { Database } from "../client.js";
import { withPlatformContext } from "../rls.js";
import {
  listIndexDefinitions,
  upsertIndexDefinition,
  type UpsertIndexDefinitionInput,
} from "../analytics/index-engine.js";
import { insertBreakGlassAudit } from "./audit.js";

export async function listOperatorIndexDefinitions(db: Database) {
  return listIndexDefinitions(db);
}

export async function upsertOperatorIndexDefinition(
  db: Database,
  input: UpsertIndexDefinitionInput & { actorUserId: string },
) {
  return withPlatformContext(db, async (scoped) => {
    const row = await upsertIndexDefinition(scoped, input);
    await insertBreakGlassAudit(scoped, {
      actorUserId: input.actorUserId,
      action: "index.upsert",
      targetType: "tcg_index_definition",
      targetId: row.indexKey,
      metadata: { gameKey: row.gameKey, languageCode: row.languageCode },
    });
    return row;
  });
}
