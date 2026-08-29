import { createDbConnection } from "./client.js";
import { requirePlatformAdminConnectionUrl } from "./platform/connection.js";
import { sanitizePlatformAdminCliMessage } from "./platform/grant-by-email.js";
import {
  assertStagingSourceCommandAllowed,
  formatStagingSourceSmokeReport,
  runStagingSourceSmoke,
} from "./providers/staging.js";

async function main() {
  assertStagingSourceCommandAllowed();
  const connection = createDbConnection(requirePlatformAdminConnectionUrl());
  try {
    const report = await runStagingSourceSmoke(connection.db);
    console.log(formatStagingSourceSmokeReport(report));
  } finally {
    await connection.end();
  }
}

void main().catch((error: unknown) => {
  const raw = error instanceof Error ? error.message : "Staging source smoke failed.";
  console.error(sanitizePlatformAdminCliMessage(raw));
  process.exit(1);
});
