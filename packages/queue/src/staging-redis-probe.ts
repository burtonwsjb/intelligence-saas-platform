import { MissingRedisUrlError, requireRedisUrl } from "./env.js";
import {
  assertStagingRedisProbeAllowed,
  formatRedisTransportProbeReport,
  runRedisTransportProbe,
  StagingRedisProbeError,
} from "./probe.js";

function safeCliMessage(error: unknown): string {
  if (error instanceof StagingRedisProbeError || error instanceof MissingRedisUrlError) {
    return error.message;
  }
  return "Redis transport probe failed.";
}

async function main() {
  assertStagingRedisProbeAllowed();
  requireRedisUrl();
  const report = await runRedisTransportProbe();
  console.log(formatRedisTransportProbeReport(report));
  if (report.stages.some((stage) => stage.status !== "ok")) {
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error(safeCliMessage(error));
  process.exit(1);
});
