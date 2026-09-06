import { z } from "zod";
import { UnrecoverableJobError } from "./errors.js";

export const JOB_ENVELOPE_VERSION = 1;

const baseEnvelope = {
  job_version: z.literal(JOB_ENVELOPE_VERSION),
  job_id: z.string().min(8).max(128),
  created_at: z.string().datetime(),
  request_id: z.string().min(8).max(128).optional(),
};

export const jobEnvelopeSchema = z.discriminatedUnion("job_type", [
  z.object({
    ...baseEnvelope,
    job_type: z.literal("source_event.normalize"),
    organization_id: z.string().min(1).max(128),
    source_event_id: z.string().min(8).max(128),
  }),
  z.object({
    ...baseEnvelope,
    job_type: z.literal("tcg.market.normalize.v1"),
    market_ingest_id: z.string().min(8).max(128),
    organization_id: z.string().min(1).max(128).optional(),
  }),
  z.object({
    ...baseEnvelope,
    job_type: z.literal("source.intelligence.normalize.v1"),
    source_ingest_id: z.string().min(8).max(128),
    organization_id: z.string().min(1).max(128).optional(),
  }),
  z.object({
    ...baseEnvelope,
    job_type: z.literal("provider.sync.v1"),
    provider_key: z.string().min(2).max(64),
    discovery_query: z.string().trim().min(3).max(120).optional(),
    trigger: z.enum(["admin", "schedule"]).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  z.object({
    ...baseEnvelope,
    job_type: z.literal("creator.extract.v1"),
    content_id: z.string().min(8).max(128),
  }),
  z.object({
    ...baseEnvelope,
    job_type: z.literal("intelligence.recompute.v1"),
    printing_id: z.string().min(8).max(128),
    as_of: z.string().datetime(),
  }),
]);

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

export function createMarketNormalizeEnvelope(input: {
  jobId: string;
  marketIngestId: string;
  requestId?: string;
}): JobEnvelope {
  return {
    job_version: JOB_ENVELOPE_VERSION,
    job_type: "tcg.market.normalize.v1",
    job_id: input.jobId,
    market_ingest_id: input.marketIngestId,
    created_at: new Date().toISOString(),
    request_id: input.requestId,
  };
}

export function createSourceNormalizeEnvelope(input: {
  jobId: string;
  sourceIngestId: string;
  requestId?: string;
}): JobEnvelope {
  return {
    job_version: JOB_ENVELOPE_VERSION,
    job_type: "source.intelligence.normalize.v1",
    job_id: input.jobId,
    source_ingest_id: input.sourceIngestId,
    created_at: new Date().toISOString(),
    request_id: input.requestId,
  };
}

export function createProviderSyncEnvelope(input: {
  jobId: string;
  providerKey: string;
  limit?: number;
  requestId?: string;
}): JobEnvelope {
  return {
    job_version: JOB_ENVELOPE_VERSION,
    job_type: "provider.sync.v1",
    job_id: input.jobId,
    provider_key: input.providerKey,
    limit: input.limit,
    created_at: new Date().toISOString(),
    request_id: input.requestId,
  };
}

export function createCreatorExtractEnvelope(input: {
  jobId: string;
  contentId: string;
  requestId?: string;
}): JobEnvelope {
  return {
    job_version: JOB_ENVELOPE_VERSION,
    job_type: "creator.extract.v1",
    job_id: input.jobId,
    content_id: input.contentId,
    created_at: new Date().toISOString(),
    request_id: input.requestId,
  };
}

export function createIntelligenceRecomputeEnvelope(input: {
  jobId: string;
  printingId: string;
  asOf: string;
  requestId?: string;
}): JobEnvelope {
  return {
    job_version: JOB_ENVELOPE_VERSION,
    job_type: "intelligence.recompute.v1",
    job_id: input.jobId,
    printing_id: input.printingId,
    as_of: input.asOf,
    created_at: new Date().toISOString(),
    request_id: input.requestId,
  };
}
