import { eq } from "drizzle-orm";
import { sourceDefinition } from "../schema/kernel.js";
import type { Database } from "../client.js";

export async function getSourceDefinition(db: Database, sourceKey: string) {
  const [row] = await db
    .select()
    .from(sourceDefinition)
    .where(eq(sourceDefinition.sourceKey, sourceKey))
    .limit(1);
  return row ?? null;
}

export async function listSourceDefinitions(db: Database) {
  return db.select().from(sourceDefinition);
}
