import { describe, expect, it } from "vitest";
import type { Database } from "@isp/db";
import { UnrecoverableJobError } from "./errors.js";
import { processNormalizeJob } from "./process.js";

describe("processNormalizeJob", () => {
  it("fails closed on an unknown or invalid envelope before touching tenant data", async () => {
    const db = {} as Database;
    await expect(processNormalizeJob(db, { hello: "world" })).rejects.toBeInstanceOf(
      UnrecoverableJobError,
    );
    await expect(
      processNormalizeJob(db, {
        job_version: 1,
        job_type: "observations.create",
        job_id: "job_12345678",
        organization_id: "org_a",
        source_event_id: "event_12345678",
        created_at: "2026-08-16T00:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(UnrecoverableJobError);
  });
});
