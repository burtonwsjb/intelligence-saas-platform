import { z } from "zod";
import { UnrecoverableJobError } from "./errors.js";
import { JOB_TYPES } from "./names.js";

export const JOB_ENVELOPE_VERSION = 1;

export const jobEnvelopeSchema = z.object({
  job_version: z.literal(JOB_ENVELOPE_VERSION),
  job_type: z.enum(JOB_TYPES),
  job_id: z.string().min(8).max(128),
  organization_id: z.string().min(1).max(128),
  source_event_id: z.string().min(8).max(128),
  created_at: z.string().datetime(),
  request_id: z.string().min(8).max(128).optional(),
});

export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;

export function parseJobEnvelope(value: unknown): JobEnvelope {
  const parsed = jobEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    throw new UnrecoverableJobError("Invalid job envelope.");
  }
  return parsed.data;
}

export function createNormalizeEnvelope(input: {
  jobId: string;
  organizationId: string;
  sourceEventId: string;
  requestId?: string;
}): JobEnvelope {
  return {
    job_version: JOB_ENVELOPE_VERSION,
    job_type: "source_event.normalize",
    job_id: input.jobId,
    organization_id: input.organizationId,
    source_event_id: input.sourceEventId,
    created_at: new Date().toISOString(),
    request_id: input.requestId,
  };
}
