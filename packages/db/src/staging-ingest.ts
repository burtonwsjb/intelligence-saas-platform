import { createDbConnection } from "./client.js";
import { requirePlatformAdminConnectionUrl } from "./platform/connection.js";
import { sanitizePlatformAdminCliMessage } from "./platform/grant-by-email.js";
import {
  assertStagingSourceCommandAllowed,
  parseStagingIngestArgs,
  runStagingIngest,
} from "./providers/staging.js";

async function main() {
  assertStagingSourceCommandAllowed();
  const args = parseStagingIngestArgs(process.argv.slice(2));
  const connection = createDbConnection(requirePlatformAdminConnectionUrl());
  try {
    const report = await runStagingIngest(connection.db, args);
    console.log(
      [
        `provider: ${report.provider}`,
        `limit: ${report.limit}`,
        `status: ${report.status}`,
        `received: ${report.received}`,
        `quarantined: ${report.quarantined}`,
        report.reason ? `reason: ${report.reason}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } finally {
    await connection.end();
  }
}

void main().catch((error: unknown) => {
  const raw = error instanceof Error ? error.message : "Staging ingest failed.";
  console.error(sanitizePlatformAdminCliMessage(raw));
  process.exit(1);
});
