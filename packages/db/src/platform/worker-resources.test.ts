import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { scheduledSlot } from "@isp/shared";
import type { Database } from "../client.js";
import { readMigrationSql } from "../migrations.js";
import { listPendingOutboxRefs } from "../repos/outbox.js";
import { listPendingPlatformOutbox } from "../providers/outbox.js";
import {
  claimScheduledJob,
  claimScheduledRun,
  finishScheduledJob,
  finishScheduledRun,
  getWorkerResources,
  scheduledClaimAllowsRedis,
} from "./worker-resources.js";

describe("scheduled free-only worker batches", () => {
  let client: PGlite;
  let db: Database;
  beforeAll(async () => {
    client = new PGlite();
    await client.exec(await readMigrationSql());
    db = drizzle(client) as unknown as Database;
    await client.exec(`
      INSERT INTO "organization" (id, name, slug) VALUES ('wr_org', 'WR', 'wr-org');
      INSERT INTO source_event (id, organization_id, event_type, occurred_at, idempotency_key, fingerprint)
        VALUES ('wr_evt', 'wr_org', 'test', now(), 'wr_idem', 'wr_fp');`);
  }, 60_000);
  afterAll(async () => { await client?.close(); });
  beforeEach(async () => {
    await client.exec(`
      DELETE FROM scheduled_job_claim; DELETE FROM scheduled_worker_run;
      DELETE FROM outbox_job; DELETE FROM platform_outbox;
      UPDATE worker_resource_settings SET enabled = true, mode = 'free_only', interval_hours = 1, max_jobs = 60;`);
  });

  async function openRun(id: string, maxJobs = 60, mode = "free_only") {
    await client.query(
      `INSERT INTO scheduled_worker_run (id, slot, mode, deadline_at, max_jobs)
       VALUES ($1, $1, $2, now() + interval '3 minutes', $3)`,
      [id, mode, maxJobs],
    );
  }
  async function addJobs() {
    await client.exec(`
      INSERT INTO platform_outbox (id, job_type, payload, available_at)
        VALUES ('wr_platform', 'provider.sync.v1', '{"job_id":"wr_platform"}', now() - interval '2 minutes');
      INSERT INTO outbox_job (id, organization_id, source_event_id, job_type, payload, available_at)
        VALUES ('wr_tenant', 'wr_org', 'wr_evt', 'source_event.normalize', '{"job_id":"wr_tenant"}', now() - interval '1 minute');`);
  }

  it("seeds a free-only, enabled, hourly default the owner can change", async () => {
    const { settings, runs } = await getWorkerResources(db);
    expect(settings).toMatchObject({ id: "global", enabled: true, mode: "free_only", interval_hours: 1, max_jobs: 60 });
    expect(runs).toEqual([]);
  });

  it("uses the same Phoenix wall-clock rule as the TypeScript scheduler", async () => {
    // 2026-01-15 07:00Z is 00:00 in Phoenix (UTC-7, no daylight saving).
    const start = Date.UTC(2026, 0, 15, 7, 0);
    for (const interval of [1, 2, 4]) {
      for (let minute = 0; minute < 24 * 60; minute += 3) {
        const at = new Date(start + minute * 60_000);
        const result = await client.query<{ slot: string | null }>(
          "SELECT app.scheduled_slot($1::timestamptz, $2) AS slot", [at.toISOString(), interval]);
        expect(result.rows[0]?.slot ?? null, `${at.toISOString()} every ${interval}h`).toBe(scheduledSlot(at, interval));
      }
    }
    const july = new Date(Date.UTC(2026, 6, 1, 13, 2));
    expect((await client.query<{ slot: string }>("SELECT app.scheduled_slot($1::timestamptz, 1) AS slot",
      [july.toISOString()])).rows[0]?.slot).toBe("2026-07-01T06:00-07:00");
  });

  it("admits a batch only in a slot, once, and never beside an open or unresolved batch", async () => {
    const expected = scheduledSlot(new Date());
    const first = await claimScheduledRun(db);
    if (expected === null) {
      expect(first).toBeNull();
    } else {
      expect(first).toMatchObject({ slot: expected, mode: "free_only", status: "running", max_jobs: 60 });
      expect(await claimScheduledRun(db)).toBeNull();
      await finishScheduledRun(db, first!.id, "completed");
      expect(await claimScheduledRun(db)).toBeNull(); // same slot: no second batch
    }
    await client.exec("DELETE FROM scheduled_worker_run");
    await openRun("wr_unresolved");
    await client.exec("UPDATE scheduled_worker_run SET status = 'indeterminate'");
    expect(await claimScheduledRun(db)).toBeNull();
    await client.exec("DELETE FROM scheduled_worker_run; UPDATE worker_resource_settings SET enabled = false");
    expect(await claimScheduledRun(db)).toBeNull();
  });

  it("caps metered windows at 600 commands within 12,000 a day and 400,000 a month", async () => {
    const at = "2026-03-20T19:00:00Z"; // 12:00 Phoenix
    const allows = async () => (await client.query<{ ok: boolean }>(
      "SELECT app.metered_redis_budget_allows($1::timestamptz) AS ok", [at])).rows[0]?.ok;
    expect(await allows()).toBe(true);
    await client.query(`INSERT INTO scheduled_worker_run (id, slot, mode, status, started_at, deadline_at, max_jobs, reserved_redis_commands)
      SELECT 'm' || g, 'm' || g, 'metered_redis', 'completed', $1::timestamptz - (g || ' minutes')::interval, $1::timestamptz, 60, 600
      FROM generate_series(1, 19) g`, [at]);
    expect(await allows()).toBe(true); // 11,400 used today
    await client.query(`INSERT INTO scheduled_worker_run (id, slot, mode, status, started_at, deadline_at, max_jobs, reserved_redis_commands)
      VALUES ('m20', 'm20', 'metered_redis', 'completed', $1::timestamptz - interval '30 minutes', $1::timestamptz, 60, 600)`, [at]);
    expect(await allows()).toBe(false); // 12,000 used today
    await client.exec("DELETE FROM scheduled_worker_run");
    await client.query(`INSERT INTO scheduled_worker_run (id, slot, mode, status, started_at, deadline_at, max_jobs, reserved_redis_commands)
      SELECT 'd' || g, 'd' || g, 'metered_redis', 'completed', '2026-03-01T08:00:00Z'::timestamptz + (g || ' minutes')::interval, now(), 60, 600
      FROM generate_series(1, 665) g`);
    expect(await allows()).toBe(true); // 399,000 used this month, none today
    await client.query(`INSERT INTO scheduled_worker_run (id, slot, mode, status, started_at, deadline_at, max_jobs, reserved_redis_commands)
      VALUES ('d666', 'd666', 'metered_redis', 'completed', '2026-03-02T08:00:00Z', now(), 60, 600)`);
    expect(await allows()).toBe(false);
  });

  it("drains both outboxes oldest first and never reclaims handled or unresolved work", async () => {
    await addJobs();
    await openRun("wr_run_1", 2);
    const platform = await claimScheduledJob(db, "wr_run_1");
    expect(platform).toMatchObject({ kind: "platform", job_id: "wr_platform", organization_id: null, attempt: 1 });
    await finishScheduledJob(db, "wr_run_1", platform!, "processed");
    const tenant = await claimScheduledJob(db, "wr_run_1");
    expect(tenant).toMatchObject({ kind: "tenant", job_id: "wr_tenant", organization_id: "wr_org", attempt: 1 });
    expect(tenant?.payload).toEqual({ job_id: "wr_tenant" });
    // Redis dispatch must not see a job the scheduled path is running.
    expect(await listPendingOutboxRefs(db)).toEqual([]);
    expect(await scheduledClaimAllowsRedis(db, "tenant", "wr_tenant")).toBe(false);
    await finishScheduledJob(db, "wr_run_1", tenant!, "retry", "processing_failed");
    await expect(finishScheduledJob(db, "wr_run_1", tenant!, "processed")).rejects.toThrow();
    expect(await claimScheduledJob(db, "wr_run_1")).toBeNull(); // max_jobs reached
    await finishScheduledRun(db, "wr_run_1", "completed");

    const statuses = await client.query("SELECT id, status, attempts FROM platform_outbox UNION ALL SELECT id, status, attempts FROM outbox_job ORDER BY id");
    expect(statuses.rows).toEqual([
      { id: "wr_platform", status: "processed", attempts: 0 },
      { id: "wr_tenant", status: "pending", attempts: 1 },
    ]);
    const run = (await getWorkerResources(db)).runs[0];
    expect(run).toMatchObject({ id: "wr_run_1", status: "completed", attempted: 2, processed: 1, failures: 1 });

    await openRun("wr_run_2");
    expect(await claimScheduledJob(db, "wr_run_2")).toBeNull(); // retry is delayed, not hot-looped
    await client.exec("UPDATE outbox_job SET available_at = now() - interval '1 second'");
    expect(await scheduledClaimAllowsRedis(db, "tenant", "wr_tenant")).toBe(true);
    const again = await claimScheduledJob(db, "wr_run_2");
    expect(again).toMatchObject({ job_id: "wr_tenant", attempt: 2 });
    await finishScheduledJob(db, "wr_run_2", again!, "indeterminate", "processing_timeout");
    await finishScheduledRun(db, "wr_run_2", "indeterminate", "batch_requires_review");
    expect(await listPendingOutboxRefs(db)).toEqual([]);
    expect(await scheduledClaimAllowsRedis(db, "tenant", "wr_tenant")).toBe(false);
    await openRun("wr_run_3");
    expect(await claimScheduledJob(db, "wr_run_3")).toBeNull();
  });

  it("marks terminal failures and keeps unclaimed platform work visible to Redis dispatch", async () => {
    await addJobs();
    expect((await listPendingPlatformOutbox(db)).map((row) => row.id)).toEqual(["wr_platform"]);
    await openRun("wr_run_f");
    const platform = await claimScheduledJob(db, "wr_run_f");
    expect(await listPendingPlatformOutbox(db)).toEqual([]);
    await finishScheduledJob(db, "wr_run_f", platform!, "failed", "processing_failed");
    const tenant = await claimScheduledJob(db, "wr_run_f");
    await finishScheduledJob(db, "wr_run_f", tenant!, "failed", "processing_failed");
    const rows = await client.query("SELECT status, last_error FROM platform_outbox UNION ALL SELECT status, last_error FROM outbox_job");
    expect(rows.rows).toEqual([
      { status: "failed", last_error: "processing_failed" },
      { status: "failed", last_error: "processing_failed" },
    ]);
  });

  it("refuses jobs for metered, expired or closed runs", async () => {
    await addJobs();
    await openRun("wr_metered", 60, "metered_redis");
    expect(await claimScheduledJob(db, "wr_metered")).toBeNull();
    await openRun("wr_expired");
    await client.exec("UPDATE scheduled_worker_run SET deadline_at = now() - interval '1 second' WHERE id = 'wr_expired'");
    expect(await claimScheduledJob(db, "wr_expired")).toBeNull();
    await openRun("wr_closed");
    await finishScheduledRun(db, "wr_closed", "completed");
    expect(await claimScheduledJob(db, "wr_closed")).toBeNull();
    expect(await claimScheduledJob(db, "missing")).toBeNull();
  });
});
