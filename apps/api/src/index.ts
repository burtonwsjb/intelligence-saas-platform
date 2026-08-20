import { serve } from "@hono/node-server";
import {
  assertHostedSecrets,
  assertProductionIdentifiers,
  structuredLog,
} from "@isp/shared";
import { app } from "./app.js";

assertHostedSecrets();
assertProductionIdentifiers();

const parsed = Number.parseInt(process.env.PORT ?? "3001", 10);
if (!Number.isFinite(parsed) || parsed <= 0) {
  throw new Error("PORT must be a positive integer.");
}
const port = parsed;

const server = serve({ fetch: app.fetch, port }, () => {
  structuredLog("info", "api.listening", { port });
});

function shutdown(signal: string) {
  structuredLog("info", "api.shutdown", { signal });
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
