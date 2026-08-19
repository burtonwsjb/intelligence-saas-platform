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

export type MachineContext = {
  organizationId: string;
  apiKeyId: string;
};

export type SystemContext = {
  organizationId: string;
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
  principal_type?: string | null;
  api_key_id?: string | null;
} | undefined {
  if (Array.isArray(result)) {
    return result[0] as {
      organization_id?: string | null;
      user_id?: string | null;
      principal_type?: string | null;
      api_key_id?: string | null;
    };
  }
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows: unknown[] }).rows;
    return rows[0] as {
      organization_id?: string | null;
      user_id?: string | null;
      principal_type?: string | null;
      api_key_id?: string | null;
    };
  }
  return undefined;
}

async function readContext(db: Database) {
  const result = await db.execute(
    sql`select
      app.current_organization_id() as organization_id,
      app.current_user_id() as user_id,
      app.current_principal_type() as principal_type,
      app.current_api_key_id() as api_key_id`,
  );
  return firstContextRow(result);
}

export async function assertTenantContext(db: Database): Promise<void> {
  const row = await readContext(db);
  if (!row?.organization_id) {
    throw new MissingTenantContextError();
  }
  if (row.principal_type === "machine") {
    if (!row.api_key_id) {
      throw new MissingTenantContextError();
    }
    return;
  }
  if (row.principal_type === "system") {
    return;
  }
  if (!row.user_id) {
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
    await tx.execute(
      sql`select set_config('app.current_principal_type', 'user', true)`,
    );
    await tx.execute(sql`select set_config('app.current_api_key_id', '', true)`);
    await assertTenantContext(tx);
    return run(tx);
  });
}

export async function withMachineContext<T>(
  db: Database,
  context: MachineContext,
  run: (db: Database) => Promise<T>,
): Promise<T> {
  const organizationId = assertContextId(context.organizationId, "organizationId");
  const apiKeyId = assertContextId(context.apiKeyId, "apiKeyId");
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.current_organization_id', ${organizationId}, true)`,
    );
    await tx.execute(sql`select set_config('app.current_user_id', '', true)`);
    await tx.execute(
      sql`select set_config('app.current_principal_type', 'machine', true)`,
    );
    await tx.execute(
      sql`select set_config('app.current_api_key_id', ${apiKeyId}, true)`,
    );
    await assertTenantContext(tx);
    return run(tx);
  });
}

export async function withSystemContext<T>(
  db: Database,
  context: SystemContext,
  run: (db: Database) => Promise<T>,
): Promise<T> {
  const organizationId = assertContextId(context.organizationId, "organizationId");
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.current_organization_id', ${organizationId}, true)`,
    );
    await tx.execute(sql`select set_config('app.current_user_id', '', true)`);
    await tx.execute(
      sql`select set_config('app.current_principal_type', 'system', true)`,
    );
    await tx.execute(sql`select set_config('app.current_api_key_id', '', true)`);
    await assertTenantContext(tx);
    return run(tx);
  });
}

export async function withPlatformContext<T>(
  db: Database,
  run: (db: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_organization_id', '', true)`);
    await tx.execute(sql`select set_config('app.current_user_id', '', true)`);
    await tx.execute(sql`select set_config('app.current_principal_type', 'system', true)`);
    await tx.execute(sql`select set_config('app.current_api_key_id', '', true)`);
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
