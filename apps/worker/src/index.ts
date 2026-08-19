import { startWorker } from "./worker.js";

const handle = startWorker();

function shutdown(signal: string) {
  console.log(`worker: received ${signal}, stopping`);
  void handle.stop().then(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
