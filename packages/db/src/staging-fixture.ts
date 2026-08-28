import { createDbConnection } from "./client.js";
import { requirePlatformAdminConnectionUrl } from "./platform/connection.js";
import { sanitizePlatformAdminCliMessage } from "./platform/grant-by-email.js";
import {
  assertStagingFixtureAllowed,
  formatStagingFixtureReport,
  runStagingFixturePipeline,
} from "./platform/staging-fixture.js";

async function main() {
  assertStagingFixtureAllowed();
  const connection = createDbConnection(requirePlatformAdminConnectionUrl());
  try {
    const counts = await runStagingFixturePipeline(connection.db);
    console.log(formatStagingFixtureReport(counts));
  } finally {
    await connection.end();
  }
}

void main().catch((error: unknown) => {
  const raw = error instanceof Error ? error.message : "Staging fixture pipeline failed.";
  console.error(sanitizePlatformAdminCliMessage(raw));
  process.exit(1);
});
