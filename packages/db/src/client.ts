import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";
import { requireDatabaseUrl, requireWorkerDatabaseUrl } from "./env.js";

export type Database = PostgresJsDatabase<typeof schema>;

export function createDb(url: string): Database {
  return createDbConnection(url).db;
}

function shouldRequireSsl(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes("sslmode=require") ||
    lower.includes("neon.tech") ||
    process.env.DATABASE_SSL === "require"
  );
}

export function createDbConnection(url: string): {
  db: Database;
  end: () => Promise<void>;
} {
  const client = postgres(url, {
    max: 10,
    prepare: false,
    ssl: shouldRequireSsl(url) ? true : undefined,
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

export function createDbFromWorkerEnv(
  env: NodeJS.ProcessEnv = process.env,
): Database {
  return createDb(requireWorkerDatabaseUrl(env));
}
