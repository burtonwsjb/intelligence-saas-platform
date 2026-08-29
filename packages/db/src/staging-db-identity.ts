import { sanitizePlatformAdminCliMessage } from "./platform/grant-by-email.js";
import {
  collectStagingDatabaseIdentities,
  formatStagingDatabaseIdentityReport,
} from "./providers/staging-db-identity.js";

async function main() {
  const report = await collectStagingDatabaseIdentities();
  console.log(formatStagingDatabaseIdentityReport(report));
}

void main().catch((error: unknown) => {
  const raw = error instanceof Error ? error.message : "Staging database identity failed.";
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  console.error(sanitizePlatformAdminCliMessage(cause ? `${raw}\n${cause}` : raw));
  process.exit(1);
});
