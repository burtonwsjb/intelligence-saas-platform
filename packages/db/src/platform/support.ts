import { desc, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { platformSupportCase } from "../schema/platform.js";
import { SECRET_SCAN, isSupportCaseStatus, type SupportCaseStatus } from "./catalog.js";
import { insertBreakGlassAudit } from "./audit.js";

export class SupportCaseRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupportCaseRejectedError";
  }
}

export async function insertSupportCase(
  db: Database,
  input: {
    organizationId: string;
    subject: string;
    body: string;
    createdByUserId: string;
    status?: SupportCaseStatus;
  },
) {
  const subject = input.subject.trim();
  const body = input.body.trim();
  if (subject.length < 1 || subject.length > 200) {
    throw new SupportCaseRejectedError("Support subject is empty or too long.");
  }
  if (body.length < 1 || body.length > 4000) {
    throw new SupportCaseRejectedError("Support body is empty or too long.");
  }
  if (SECRET_SCAN.test(subject) || SECRET_SCAN.test(body)) {
    throw new SupportCaseRejectedError("Support cases must not contain secrets.");
  }
  const [row] = await db
    .insert(platformSupportCase)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      subject,
      body,
      status: input.status ?? "open",
      createdByUserId: input.createdByUserId,
    })
    .returning();
  await insertBreakGlassAudit(db, {
    actorUserId: input.createdByUserId,
    action: "support.case",
    organizationId: input.organizationId,
    targetType: "platform_support_case",
    targetId: row!.id,
  });
  return row!;
}

export async function listSupportCases(db: Database, organizationId?: string) {
  if (organizationId) {
    return db
      .select()
      .from(platformSupportCase)
      .where(eq(platformSupportCase.organizationId, organizationId))
      .orderBy(desc(platformSupportCase.createdAt));
  }
  return db
    .select()
    .from(platformSupportCase)
    .orderBy(desc(platformSupportCase.createdAt))
    .limit(200);
}

export async function setSupportCaseStatus(
  db: Database,
  input: { id: string; status: string; actorUserId: string },
) {
  if (!isSupportCaseStatus(input.status)) {
    throw new SupportCaseRejectedError("Unknown support case status.");
  }
  const [row] = await db
    .update(platformSupportCase)
    .set({ status: input.status, updatedAt: new Date() })
    .where(eq(platformSupportCase.id, input.id))
    .returning();
  return row ?? null;
}
