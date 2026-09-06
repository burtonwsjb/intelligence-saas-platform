import { createDbConnection } from "./client.js";
import { requirePlatformAdminConnectionUrl } from "./platform/connection.js";
import { sanitizePlatformAdminCliMessage } from "./platform/grant-by-email.js";
import { assertStagingSourceCommandAllowed } from "./providers/staging.js";
import { runSocialDiscovery } from "./providers/discovery.js";

function parseArgs(argv: string[]) {
  const queryIndex = argv.indexOf("--query");
  const limitIndex = argv.indexOf("--limit");
  const query = queryIndex >= 0 ? argv[queryIndex + 1]?.trim() : "";
  const limit = limitIndex >= 0 ? Number.parseInt(argv[limitIndex + 1] ?? "10", 10) : 10;
  return {
    query: query || "Pokemon TCG investing",
    limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 10) : 10,
  };
}

async function main() {
  assertStagingSourceCommandAllowed();
  const args = parseArgs(process.argv.slice(2));
  const connection = createDbConnection(requirePlatformAdminConnectionUrl());
  try {
    const report = await runSocialDiscovery(connection.db, {
      providerKey: "reddit",
      query: args.query,
      limit: args.limit,
      trigger: "staging",
    });
    console.log(
      JSON.stringify({
        event: "staging.reddit_discovery",
        provider_key: report.provider_key,
        videos_seen: report.videos_seen,
        channels_seen: report.channels_seen,
        creators_linked: report.creators_linked,
        content_ingested: report.content_ingested,
        quota_units: report.quota_units,
        status: report.status,
        hardcoded_subreddit_required: false,
      }),
    );
    if (report.status !== "completed") {
      process.exitCode = 1;
    }
  } finally {
    await connection.end();
  }
}

void main().catch((error: unknown) => {
  console.error(sanitizePlatformAdminCliMessage(error instanceof Error ? error.message : "Discovery failed."));
  process.exit(1);
});
