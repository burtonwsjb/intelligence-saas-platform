import { sql } from "drizzle-orm";
import type { Database } from "./client.js";

export type OrganizationContext = {
  organizationId: string;
  userId: string;
};

export async function withOrganizationContext<T>(
  db: Database,
  context: OrganizationContext,
  run: (db: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.current_organization_id', ${context.organizationId}, true)`,
    );
    await tx.execute(
      sql`select set_config('app.current_user_id', ${context.userId}, true)`,
    );
    return run(tx);
  });
}
