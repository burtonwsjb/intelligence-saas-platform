import { sql } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  InvalidTenantContextError,
  MissingTenantContextError,
} from "./errors.js";

export type OrganizationContext = {
  organizationId: string;
  userId: string;
};

const CONTEXT_PATTERN = /^[A-Za-z0-9_:-]{1,128}$/;

export function assertContextId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!CONTEXT_PATTERN.test(trimmed)) {
    throw new InvalidTenantContextError();
  }
  if (label === "organizationId" && trimmed.length < 1) {
    throw new InvalidTenantContextError();
  }
  return trimmed;
}

export function parseOrganizationContext(
  context: OrganizationContext,
): OrganizationContext {
  return {
    organizationId: assertContextId(context.organizationId, "organizationId"),
    userId: assertContextId(context.userId, "userId"),
  };
}

function firstContextRow(result: unknown): {
  organization_id?: string | null;
  user_id?: string | null;
} | undefined {
  if (Array.isArray(result)) {
    return result[0] as { organization_id?: string | null; user_id?: string | null };
  }
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows: unknown[] }).rows;
    return rows[0] as { organization_id?: string | null; user_id?: string | null };
  }
  return undefined;
}

export async function assertTenantContext(db: Database): Promise<void> {
  const result = await db.execute(
    sql`select app.current_organization_id() as organization_id, app.current_user_id() as user_id`,
  );
  const row = firstContextRow(result);
  if (!row?.organization_id || !row.user_id) {
    throw new MissingTenantContextError();
  }
}

export async function withOrganizationContext<T>(
  db: Database,
  context: OrganizationContext,
  run: (db: Database) => Promise<T>,
): Promise<T> {
  const safe = parseOrganizationContext(context);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.current_organization_id', ${safe.organizationId}, true)`,
    );
    await tx.execute(
      sql`select set_config('app.current_user_id', ${safe.userId}, true)`,
    );
    await assertTenantContext(tx);
    return run(tx);
  });
}

export async function withTenantScope<T>(
  db: Database,
  context: OrganizationContext,
  run: (db: Database) => Promise<T>,
): Promise<T> {
  return withOrganizationContext(db, context, run);
}
