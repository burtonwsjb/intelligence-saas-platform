import { createDbConnection } from "./client.js";
import { requirePlatformAdminConnectionUrl } from "./platform/connection.js";
import {
  formatGrantPlatformAdminReport,
  grantPlatformAdminByEmail,
  parseGrantPlatformAdminArgs,
  sanitizePlatformAdminCliMessage,
} from "./platform/grant-by-email.js";

async function main() {
  const input = parseGrantPlatformAdminArgs(process.argv.slice(2));
  const connection = createDbConnection(requirePlatformAdminConnectionUrl());
  try {
    const result = await grantPlatformAdminByEmail(connection.db, input);
    console.log(formatGrantPlatformAdminReport(result));
  } finally {
    await connection.end();
  }
}

void main().catch((error: unknown) => {
  const raw = error instanceof Error ? error.message : "Platform admin grant failed.";
  console.error(sanitizePlatformAdminCliMessage(raw));
  process.exit(1);
});
