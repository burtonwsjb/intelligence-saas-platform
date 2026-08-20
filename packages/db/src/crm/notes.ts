import { desc, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { crmOperatorNote } from "../schema/crm.js";
import { isOperatorNoteCategory } from "./catalog.js";

const SECRET_PATTERN = /sk_live_|sk_test_|whsec_|isp_(?:test|live)_[A-Za-z0-9]+|RESEND_API_KEY|BEGIN (?:RSA )?PRIVATE KEY/i;

export class OperatorNoteRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorNoteRejectedError";
  }
}

/**
 * Operator notes are platform-admin data. Callers must use a BYPASSRLS role
 * (`app_admin` / migrate). Tenant `app_user` policies return no rows.
 */
export async function insertOperatorNote(
  db: Database,
  input: {
    organizationId: string;
    authorUserId?: string | null;
    category: string;
    body: string;
  },
) {
  if (!isOperatorNoteCategory(input.category)) {
    throw new OperatorNoteRejectedError("Unknown operator note category.");
  }
  const body = input.body.trim();
  if (body.length < 1 || body.length > 4000) {
    throw new OperatorNoteRejectedError("Operator note body is empty or too long.");
  }
  if (SECRET_PATTERN.test(body)) {
    throw new OperatorNoteRejectedError("Operator notes must not contain secrets.");
  }
  const [row] = await db
    .insert(crmOperatorNote)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      authorUserId: input.authorUserId ?? null,
      category: input.category,
      body,
    })
    .returning();
  return row!;
}

export async function listOperatorNotes(db: Database, organizationId: string) {
  return db
    .select()
    .from(crmOperatorNote)
    .where(eq(crmOperatorNote.organizationId, organizationId))
    .orderBy(desc(crmOperatorNote.createdAt));
}

export async function updateOperatorNote(
  db: Database,
  input: { id: string; body: string },
) {
  const body = input.body.trim();
  if (body.length < 1 || body.length > 4000) {
    throw new OperatorNoteRejectedError("Operator note body is empty or too long.");
  }
  if (SECRET_PATTERN.test(body)) {
    throw new OperatorNoteRejectedError("Operator notes must not contain secrets.");
  }
  const [row] = await db
    .update(crmOperatorNote)
    .set({ body, updatedAt: new Date() })
    .where(eq(crmOperatorNote.id, input.id))
    .returning();
  return row ?? null;
}
