import { requireDatabaseAdminUrl } from "./env.js";
import { applyMigrations } from "./migrate-lib.js";

async function main() {
  const url = requireDatabaseAdminUrl();
  await applyMigrations(url);
  console.log("db: migrations applied");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
