import postgres from "postgres";
import { readMigrationSql } from "./migrations.js";

export async function applyMigrations(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, prepare: false });
  try {
    await sql.unsafe(await readMigrationSql());
  } finally {
    await sql.end({ timeout: 5 });
  }
}
