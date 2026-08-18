import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readMigrationSql } from "@isp/db";
import * as tables from "@isp/db";
import type { Database } from "@isp/db";

export async function createTestDatabase(): Promise<Database> {
  const client = new PGlite();
  await client.exec(await readMigrationSql());
  return drizzle(client, {
    schema: {
      user: tables.user,
      session: tables.session,
      account: tables.account,
      verification: tables.verification,
      organization: tables.organization,
      member: tables.member,
      invitation: tables.invitation,
      tenant: tables.tenant,
    },
  }) as unknown as Database;
}
