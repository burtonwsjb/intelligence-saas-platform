import { describe, expect, it } from "vitest";
import { UnrecoverableJobError } from "./errors.js";
import { createMarketNormalizeEnvelope, createNormalizeEnvelope, createSourceNormalizeEnvelope, parseJobEnvelope } from "./envelope.js";
import { DEFAULT_BACKOFF_MS, DEFAULT_JOB_ATTEMPTS, ingestQueueName } from "./names.js";
import { queueEnvironmentName, requireRedisUrl, MissingRedisUrlError } from "./env.js";

describe("job envelope", () => {
  it("accepts a versioned normalize envelope and rejects unknown types", () => {
    const envelope = createNormalizeEnvelope({
      jobId: "outbox_12345678",
      organizationId: "org_a",
      sourceEventId: "event_12345678",
      requestId: "req_12345678",
    });
    expect(parseJobEnvelope(envelope).job_type).toBe("source_event.normalize");
    expect(() =>
      parseJobEnvelope({ ...envelope, job_type: "observations.create" }),
    ).toThrow(UnrecoverableJobError);
    expect(() => parseJobEnvelope({ hello: "world" })).toThrow(UnrecoverableJobError);
  });

  it("accepts a versioned TCG market normalize envelope", () => {
    const envelope = createMarketNormalizeEnvelope({
      jobId: "outbox_market01",
      marketIngestId: "min_12345678",
    });
    expect(parseJobEnvelope(envelope).job_type).toBe("tcg.market.normalize.v1");
    expect(() =>
      parseJobEnvelope({ ...envelope, source_event_id: "event_12345678" }),
    ).not.toThrow();
  });

  it("accepts a versioned source intelligence normalize envelope", () => {
    const envelope = createSourceNormalizeEnvelope({
      jobId: "outbox_source01",
      sourceIngestId: "sin_12345678",
    });
    expect(parseJobEnvelope(envelope).job_type).toBe("source.intelligence.normalize.v1");
  });
});

describe("queue naming and redis env", () => {
  it("namespaces queues by environment and fails closed without REDIS_URL", () => {
    expect(queueEnvironmentName({ NODE_ENV: "test" })).toBe("test");
    expect(queueEnvironmentName({ NODE_ENV: "production" })).toBe("production");
    expect(queueEnvironmentName({ ISP_ENV: "staging", NODE_ENV: "production" })).toBe("staging");
    expect(ingestQueueName({ NODE_ENV: "test" })).toBe("isp-test-ingest");
    expect(DEFAULT_JOB_ATTEMPTS).toBe(5);
    expect(DEFAULT_BACKOFF_MS).toBe(2_000);
    expect(() => requireRedisUrl({})).toThrow(MissingRedisUrlError);
  });
});
