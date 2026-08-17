import { startWorker } from "./worker.js";

const { stop } = startWorker();

function shutdown(signal: string) {
  console.log(`worker: received ${signal}, stopping`);
  stop();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
