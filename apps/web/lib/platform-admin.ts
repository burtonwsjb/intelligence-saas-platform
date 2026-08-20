import "server-only";
import { redirect } from "next/navigation";
import {
  checkPlatformAdminAccess,
  createDb,
  isPlatformAdminDbNotConfiguredError,
  resolvePlatformAdminConnectionUrl,
  type Database,
} from "@isp/db";
import { getDb } from "@/lib/auth";
import { requirePageSession } from "@/lib/session";

let cachedAdmin: Database | undefined;

export function tryGetPlatformAdminDb(): Database | null {
  try {
    if (!cachedAdmin) {
      cachedAdmin = createDb(resolvePlatformAdminConnectionUrl());
    }
    return cachedAdmin;
  } catch (error) {
    if (isPlatformAdminDbNotConfiguredError(error)) {
      return null;
    }
    throw error;
  }
}

export async function requirePlatformOperator() {
  const session = await requirePageSession();
  const access = await checkPlatformAdminAccess(getDb(), {
    userId: session.user.id,
    email: session.user.email,
  });
  return {
    session,
    access,
    adminDb: access.granted ? tryGetPlatformAdminDb() : null,
    denied: !access.granted,
  };
}

export async function requireGrantedOperator() {
  const operator = await requirePlatformOperator();
  if (operator.denied) {
    redirect("/admin");
  }
  return operator;
}
