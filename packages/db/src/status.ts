import { drizzleDirectory, listMigrationFiles } from "./migrations.js";

async function main() {
  const files = await listMigrationFiles();
  console.log(`drizzle directory: ${drizzleDirectory()}`);
  if (files.length === 0) {
    console.log("no migration files");
    return;
  }
  for (const file of files) {
    console.log(file);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
