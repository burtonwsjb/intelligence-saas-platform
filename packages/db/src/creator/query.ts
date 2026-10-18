import { and, desc, eq, gte, isNull, lte } from "drizzle-orm";
import type { Database } from "../client.js";
import { creator, creatorCall, creatorCallOutcome, creatorSourceAccount } from "../schema/creator.js";
import { sourceAccount } from "../schema/source.js";

export async function listCreators(db: Database) {
  return db.select().from(creator);
}

export async function listCreatorAccounts(db: Database, creatorId: string) {
  return db.select().from(creatorSourceAccount).where(eq(creatorSourceAccount.creatorId, creatorId));
}

/** Public profile links for a creator's accounts, for display only. */
export async function listCreatorAccountLinks(db: Database, creatorId: string) {
  const rows = await db
    .select({
      sourceType: sourceAccount.sourceType,
      handle: sourceAccount.handle,
      externalAccountId: sourceAccount.externalAccountId,
      canonicalUrl: sourceAccount.canonicalUrl,
    })
    .from(creatorSourceAccount)
    .innerJoin(sourceAccount, eq(sourceAccount.id, creatorSourceAccount.sourceAccountId))
    .where(eq(creatorSourceAccount.creatorId, creatorId))
    .limit(10);
  return rows
    .filter((row) => row.canonicalUrl && /^https:\/\/(www\.)?(youtube\.com|reddit\.com)\//.test(row.canonicalUrl))
    .map((row) => ({
      url: row.canonicalUrl!,
      label: `${row.sourceType === "reddit" ? "Reddit" : row.sourceType === "youtube" ? "YouTube" : row.sourceType}${
        row.handle ? ` ${row.handle}` : ""
      }`,
    }));
}

export async function listCallsByCreator(db: Database, creatorId: string) {
  return db
    .select()
    .from(creatorCall)
    .where(eq(creatorCall.creatorId, creatorId))
    .orderBy(desc(creatorCall.publishedAt));
}

export async function listCallsByPrinting(db: Database, printingId: string) {
  return db
    .select()
    .from(creatorCall)
    .where(eq(creatorCall.printingId, printingId))
    .orderBy(desc(creatorCall.publishedAt));
}

export async function listCallsByDirection(db: Database, direction: string) {
  return db
    .select()
    .from(creatorCall)
    .where(eq(creatorCall.direction, direction))
    .orderBy(desc(creatorCall.publishedAt));
}

export async function listCallsByDate(db: Database, from: Date, to: Date) {
  return db
    .select()
    .from(creatorCall)
    .where(and(gte(creatorCall.publishedAt, from), lte(creatorCall.publishedAt, to)))
    .orderBy(desc(creatorCall.publishedAt));
}

export async function listUnresolvedCalls(db: Database) {
  return db.select().from(creatorCall).where(isNull(creatorCall.printingId)).orderBy(desc(creatorCall.publishedAt));
}

export async function listCallsAwaitingOutcome(db: Database) {
  return db
    .select({ call: creatorCall, outcome: creatorCallOutcome })
    .from(creatorCallOutcome)
    .innerJoin(creatorCall, eq(creatorCall.id, creatorCallOutcome.callId))
    .where(eq(creatorCallOutcome.evaluationStatus, "pending"));
}

export async function getCreatorCall(db: Database, callId: string) {
  const [row] = await db.select().from(creatorCall).where(eq(creatorCall.id, callId)).limit(1);
  return row ?? null;
}
