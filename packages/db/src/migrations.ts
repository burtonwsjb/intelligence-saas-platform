import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function drizzleDirectory(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");
}

export async function listMigrationFiles(): Promise<string[]> {
  const dir = drizzleDirectory();
  return (await readdir(dir))
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

export async function readMigrationSql(): Promise<string> {
  const dir = drizzleDirectory();
  const files = await listMigrationFiles();
  const chunks: string[] = [];
  for (const file of files) {
    chunks.push(await readFile(path.join(dir, file), "utf8"));
  }
  return chunks.join("\n");
}
