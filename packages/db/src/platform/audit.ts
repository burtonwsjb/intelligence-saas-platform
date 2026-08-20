import { desc, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { platformBreakGlassAudit } from "../schema/platform.js";
import {
  isBreakGlassAction,
  sanitizeAuditMetadata,
  type BreakGlassAction,
} from "./catalog.js";

export class UnknownBreakGlassActionError extends Error {
  constructor() {
    super("Unknown platform break-glass action.");
    this.name = "UnknownBreakGlassActionError";
  }
}

export async function insertBreakGlassAudit(
  db: Database,
  input: {
    actorUserId: string;
    action: BreakGlassAction | string;
    organizationId?: string | null;
    targetType?: string | null;
    targetId?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  if (!isBreakGlassAction(input.action)) {
    throw new UnknownBreakGlassActionError();
  }
  const [row] = await db
    .insert(platformBreakGlassAudit)
    .values({
      id: crypto.randomUUID(),
      actorUserId: input.actorUserId,
      action: input.action,
      organizationId: input.organizationId ?? null,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata: sanitizeAuditMetadata(input.metadata),
    })
    .returning();
  return row!;
}

export async function listBreakGlassAudit(db: Database, limit = 100) {
  return db
    .select()
    .from(platformBreakGlassAudit)
    .orderBy(desc(platformBreakGlassAudit.createdAt))
    .limit(Math.min(limit, 500));
}

export async function listBreakGlassAuditForOrganization(db: Database, organizationId: string) {
  return db
    .select()
    .from(platformBreakGlassAudit)
    .where(eq(platformBreakGlassAudit.organizationId, organizationId))
    .orderBy(desc(platformBreakGlassAudit.createdAt));
}
