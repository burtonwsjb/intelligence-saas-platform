import { isHostedRuntime } from "@isp/shared";
import { applyMigrations } from "./migrate-lib.js";
import { MigrationSafetyError, type MigrationOptions } from "./migration-engine.js";

export function migrationUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DATABASE_MIGRATE_URL?.trim() || (!isHostedRuntime(env) ? env.DATABASE_ADMIN_URL?.trim() : undefined);
  if (!raw) throw new MigrationSafetyError("Set DATABASE_MIGRATE_URL for this maintenance session. Hosted migrations never use DATABASE_ADMIN_URL, APP_DATABASE_URL, or WORKER_DATABASE_URL.");
  try {
    const url = new URL(raw);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) throw new Error();
  } catch {
    throw new MigrationSafetyError("DATABASE_MIGRATE_URL must contain only a Postgres connection URL, not an assignment or surrounding quotes. Its value has not been logged.");
  }
  return raw;
}
export function parseMigrationArgs(argv: string[]): MigrationOptions {
  const args = argv.filter((x) => x !== "--");
  const result: MigrationOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--plan") result.plan = true;
    else if (args[i] === "--confirm-existing-schema") result.confirmExistingSchema = true;
    else if (args[i] === "--baseline-through" && /^\d{4}(?:_[A-Za-z0-9_-]+\.sql)?$/.test(args[i + 1] ?? "")) result.baselineThrough = args[++i];
    else throw new MigrationSafetyError("Unknown migration argument. Allowed: --plan, --baseline-through <version>, --confirm-existing-schema.");
  }
  if (Boolean(result.baselineThrough) !== Boolean(result.confirmExistingSchema)) throw new MigrationSafetyError("Legacy adoption requires both --baseline-through and --confirm-existing-schema.");
  return result;
}
async function main() {
  const report = await applyMigrations(migrationUrl(), parseMigrationArgs(process.argv.slice(2)));
  console.log(JSON.stringify({ event: "db.migrations", ...report }));
  console.log(report.plan ? "db: migration plan only; no writes" : "db: migrations applied");
}
// CLI errors are sanitized: Postgres messages may contain input values/URLs.
if (process.argv[1]?.replace(/\\/g, "/").match(/\/(?:src|dist)\/migrate\.(?:ts|js)$/)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof MigrationSafetyError ? error.message : "Migration failed and was rolled back. Inspect the migration plan and schema-owner permissions; no credentials were printed.");
    process.exitCode = 1;
  });
}
