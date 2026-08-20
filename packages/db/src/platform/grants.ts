import { eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { platformAdmins } from "../schema/platform.js";
import { withActorContext } from "../rls.js";
import { emailIsLocalPlatformAdmin } from "./catalog.js";

export type PlatformAdminSource = "table" | "local_email";

export type PlatformAdminAccess = {
  granted: boolean;
  source: PlatformAdminSource | null;
};

export async function hasPlatformAdminGrant(db: Database, userId: string): Promise<boolean> {
  const rows = await withActorContext(db, userId, (scoped) =>
    scoped.select({ userId: platformAdmins.userId }).from(platformAdmins).where(eq(platformAdmins.userId, userId)),
  );
  return rows.length > 0;
}

export async function checkPlatformAdminAccess(
  db: Database,
  input: { userId: string; email?: string | null },
  env: NodeJS.ProcessEnv = process.env,
): Promise<PlatformAdminAccess> {
  if (await hasPlatformAdminGrant(db, input.userId)) {
    return { granted: true, source: "table" };
  }
  if (emailIsLocalPlatformAdmin(input.email, env)) {
    return { granted: true, source: "local_email" };
  }
  return { granted: false, source: null };
}

/**
 * Inserts a platform admin grant. Callers must use `app_admin` / migrate
 * (BYPASSRLS). Tenant `app_user` INSERT policies are deny-all.
 */
export async function grantPlatformAdmin(
  db: Database,
  input: { userId: string; grantedByUserId?: string | null; note?: string | null },
) {
  const [row] = await db
    .insert(platformAdmins)
    .values({
      userId: input.userId,
      grantedByUserId: input.grantedByUserId ?? null,
      note: input.note ?? null,
    })
    .onConflictDoNothing({ target: platformAdmins.userId })
    .returning();
  if (row) {
    return row;
  }
  const [existing] = await db
    .select()
    .from(platformAdmins)
    .where(eq(platformAdmins.userId, input.userId))
    .limit(1);
  return existing ?? null;
}
