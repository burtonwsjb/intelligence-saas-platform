import { createDbConnection } from "../client.js";
import { requirePlatformAdminConnectionUrl } from "../platform/connection.js";
import {
  formatDatabaseIdentityReport,
  inspectDatabaseIdentity,
  type DatabaseIdentity,
} from "../platform/db-identity.js";
import { assertStagingSourceCommandAllowed } from "./staging.js";

export async function collectStagingDatabaseIdentities(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DatabaseIdentity[]> {
  assertStagingSourceCommandAllowed(env);
  const rows: DatabaseIdentity[] = [];

  const adminUrl = env.DATABASE_ADMIN_URL?.trim()
    ? requirePlatformAdminConnectionUrl(env)
    : undefined;
  rows.push(await inspectConfigured("admin", adminUrl));

  const appUrl = env.APP_DATABASE_URL?.trim() || undefined;
  rows.push(await inspectConfigured("app", appUrl));

  const workerUrl = env.WORKER_DATABASE_URL?.trim() || undefined;
  rows.push(await inspectConfigured("worker", workerUrl));

  return rows;
}

async function inspectConfigured(label: string, url: string | undefined): Promise<DatabaseIdentity> {
  if (!url) {
    return inspectDatabaseIdentity({ label, url });
  }
  try {
    const connection = createDbConnection(url);
    try {
      return await inspectDatabaseIdentity({ label, url, db: connection.db });
    } finally {
      await connection.end();
    }
  } catch {
    return {
      ...(await inspectDatabaseIdentity({ label, url })),
      reachable: false,
    };
  }
}

export function formatStagingDatabaseIdentityReport(identities: DatabaseIdentity[]): string {
  return formatDatabaseIdentityReport(identities);
}
