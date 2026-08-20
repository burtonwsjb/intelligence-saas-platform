import { createServer } from "node:http";
import {
  assertHostedSecrets,
  assertProductionIdentifiers,
  structuredLog,
} from "@isp/shared";
import { startWorker } from "./worker.js";

assertHostedSecrets();
assertProductionIdentifiers();

const handle = startWorker();
structuredLog("info", "worker.process_started", {});

const healthPort = Number.parseInt(process.env.WORKER_HEALTH_PORT ?? "", 10);
if (Number.isFinite(healthPort) && healthPort > 0) {
  createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  }).listen(healthPort);
}

function shutdown(signal: string) {
  structuredLog("info", "worker.shutdown", { signal });
  void handle.stop().then(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
