import { listPendingOutboxRefs, type Database } from "@isp/db";
import { QueueUnavailableError } from "./errors.js";
import { logQueueEvent } from "./logger.js";
import { createIngestQueue, publishOutboxJob, type IngestQueue } from "./publisher.js";

export async function dispatchPendingOutbox(
  db: Database,
  input?: { queue?: IngestQueue; env?: NodeJS.ProcessEnv; limit?: number },
): Promise<{ published: number; failed: number }> {
  const refs = await listPendingOutboxRefs(db, input?.limit ?? 20);
  const queue = input?.queue ?? createIngestQueue(input?.env);
  let published = 0;
  let failed = 0;
  try {
    for (const ref of refs) {
      try {
        const result = await publishOutboxJob(db, {
          organizationId: ref.organizationId,
          outboxId: ref.id,
          queue,
          env: input?.env,
        });
        if (result.published) {
          published += 1;
        }
      } catch (error) {
        failed += 1;
        if (!(error instanceof QueueUnavailableError)) {
          logQueueEvent("warn", "outbox.dispatch_error", {
            job_id: ref.id,
            organization_id: ref.organizationId,
            status: "pending",
          });
        }
      }
    }
  } finally {
    if (!input?.queue) {
      await queue.close();
    }
  }
  return { published, failed };
}
