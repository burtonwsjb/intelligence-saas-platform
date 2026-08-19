import { requireDatabaseAdminUrl } from "./env.js";
import { bootstrapRoles } from "./bootstrap-roles.js";

function requirePassword(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required to bootstrap database roles.`);
  }
  return value;
}

async function main() {
  await bootstrapRoles(requireDatabaseAdminUrl(), {
    migrate: requirePassword("APP_MIGRATE_PASSWORD"),
    user: requirePassword("APP_USER_PASSWORD"),
    worker: requirePassword("APP_WORKER_PASSWORD"),
    admin: requirePassword("APP_ADMIN_PASSWORD"),
  });
  console.log("db: roles bootstrapped");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
