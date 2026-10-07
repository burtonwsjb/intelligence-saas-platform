import { createServer, type Server } from "node:http";
import {
  assertHostedSecrets,
  assertProductionIdentifiers,
  isHostedRuntime,
  structuredLog,
} from "@isp/shared";
import { createShutdownLatch, WORKER_SHUTDOWN_FORCE_MS } from "@isp/queue";
import { runEmailDeliverySweep, startWorker, workerHealthPayload } from "./worker.js";
import { startScheduledWorker } from "./scheduled-worker.js";

assertHostedSecrets();
assertProductionIdentifiers();

// Hosted workers never hold a standing Redis connection. They drain the
// Postgres outboxes in owner-controlled Phoenix batches; Redis is used only in
// a bounded metered window the owner explicitly enables.
const scheduled = isHostedRuntime(process.env);
const handle = scheduled
  ? startScheduledWorker({
      env: process.env,
      afterBatch: (db) => runEmailDeliverySweep(db, process.env),
      startMetered: (env, db) => startWorker({ env, db }),
    })
  : startWorker();
structuredLog("info", "worker.process_started", { execution_mode: scheduled ? "scheduled" : "continuous" });

const healthPort = Number.parseInt(process.env.WORKER_HEALTH_PORT ?? "", 10);
let healthServer: Server | undefined;
if (Number.isFinite(healthPort) && healthPort > 0) {
  healthServer = createServer((_req, res) => {
    const payload = workerHealthPayload(handle.diagnostics());
    const shuttingDown = payload.status !== "ok";
    res.writeHead(shuttingDown ? 503 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  healthServer.listen(healthPort);
}

const latch = createShutdownLatch({ forceExitMs: WORKER_SHUTDOWN_FORCE_MS });

function shutdown(signal: string) {
  structuredLog("info", "worker.shutdown", { signal });
  void latch.request(async () => {
    if (healthServer) {
      await new Promise<void>((resolve) => {
        healthServer?.close(() => resolve());
        setTimeout(resolve, 1_000);
      });
    }
    await handle.stop();
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
