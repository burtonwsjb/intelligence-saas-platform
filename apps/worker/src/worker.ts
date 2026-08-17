export function startWorker(): { stop: () => void } {
  console.log("worker: idle (phase 01 no-op)");
  const heartbeat = setInterval(() => {
    console.log("worker: idle");
  }, 60_000);
  const stop = () => {
    clearInterval(heartbeat);
  };

  return { stop };
}
