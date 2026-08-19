import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";
import { requireDatabaseUrl } from "./env.js";

export type Database = PostgresJsDatabase<typeof schema>;

export function createDb(url: string): Database {
  return createDbConnection(url).db;
}

export function createDbConnection(url: string): {
  db: Database;
  end: () => Promise<void>;
} {
  const client = postgres(url, {
    max: 10,
    prepare: false,
  });
  return {
    db: drizzle(client, { schema }),
    end: async () => {
      await client.end({ timeout: 5 });
    },
  };
}

export function createDbFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Database {
  return createDb(requireDatabaseUrl(env));
}
