import { getSourceEvent, listOutboxJobs, withSystemContext, type Database } from "@isp/db";

export async function getIngestJobStatus(
  db: Database,
  input: { organizationId: string; sourceEventId: string },
) {
  return withSystemContext(db, { organizationId: input.organizationId }, async (scoped) => {
    const event = await getSourceEvent(scoped, {
      organizationId: input.organizationId,
      id: input.sourceEventId,
    });
    const jobs = (await listOutboxJobs(scoped, input.organizationId)).filter(
      (row) => row.sourceEventId === input.sourceEventId,
    );
    return {
      sourceEventId: input.sourceEventId,
      organizationId: input.organizationId,
      processingStatus: event?.processingStatus ?? null,
      failureCategory: event?.failureCategory ?? null,
      failureMessage: event?.failureMessage ?? null,
      outbox: jobs,
    };
  });
}
