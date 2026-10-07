import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  applyMigrations,
  assertDisposableAdminUrl,
  bootstrapRoles,
  claimScheduledJob,
  createDbConnection,
  DB_ROLES,
  finishScheduledJob,
  getWorkerResources,
  replaceConnectionRole,
  requireDatabaseAdminUrl,
  testRolePasswords,
  updateWorkerResources,
  withPlatformContext,
} from "./index.js";

const passwords = testRolePasswords();

describe("worker resource roles", () => {
  let adminUrl: string;
  let admin: ReturnType<typeof postgres> | undefined;
  let worker: ReturnType<typeof createDbConnection> | undefined;
  let user: ReturnType<typeof createDbConnection> | undefined;
  let platformAdmin: ReturnType<typeof createDbConnection> | undefined;

  beforeAll(async () => {
    adminUrl = requireDatabaseAdminUrl();
    assertDisposableAdminUrl(adminUrl);
    await applyMigrations(adminUrl);
    await bootstrapRoles(adminUrl, passwords);
    admin = postgres(adminUrl, { max: 1, prepare: false });
    worker = createDbConnection(replaceConnectionRole(adminUrl, DB_ROLES.worker, passwords.worker));
    user = createDbConnection(replaceConnectionRole(adminUrl, DB_ROLES.user, passwords.user));
    platformAdmin = createDbConnection(replaceConnectionRole(adminUrl, DB_ROLES.admin, passwords.admin));
    await admin.unsafe(`
      INSERT INTO "user" (id, name, email, email_verified)
      VALUES ('wr_owner', 'Owner', 'wr-owner@example.com', true),
             ('wr_delegate', 'Delegate', 'wr-delegate@example.com', true)
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO platform_admins (user_id, granted_by_user_id)
      VALUES ('wr_owner', NULL), ('wr_delegate', 'wr_owner')
      ON CONFLICT (user_id) DO NOTHING;
      DELETE FROM scheduled_job_claim WHERE run_id = 'wr_pg_run';
      DELETE FROM scheduled_worker_run WHERE id = 'wr_pg_run';
      DELETE FROM platform_outbox WHERE id = 'wr_pg_platform_job';
      INSERT INTO scheduled_worker_run (id, slot, mode, deadline_at, max_jobs)
      VALUES ('wr_pg_run', 'wr_pg_run', 'free_only', now() + interval '3 minutes', 1);
      INSERT INTO platform_outbox (id, job_type, payload, available_at)
      VALUES ('wr_pg_platform_job', 'provider.sync.v1', '{}', now() - interval '1 hour');
    `);
  });

  afterAll(async () => {
    await admin?.unsafe(`
      UPDATE scheduled_worker_run SET status = 'completed' WHERE id = 'wr_pg_run';
      UPDATE worker_resource_settings SET enabled = true, mode = 'free_only', interval_hours = 1, max_jobs = 60;`);
    await worker?.end();
    await user?.end();
    await platformAdmin?.end();
    await admin?.end({ timeout: 5 });
  });

  it("lets the worker read settings and run claims only through the functions", async () => {
    const db = worker!.db;
    const { settings } = await getWorkerResources(db);
    expect(settings.mode).toBe("free_only");
    const job = await claimScheduledJob(db, "wr_pg_run");
    expect(job).toMatchObject({ kind: "platform", job_id: "wr_pg_platform_job" });
    await finishScheduledJob(db, "wr_pg_run", job!, "processed");
    await expect(withPlatformContext(db, (tx) =>
      tx.execute("UPDATE worker_resource_settings SET mode = 'metered_redis'"))).rejects.toThrow();
    await expect(withPlatformContext(db, (tx) =>
      tx.execute("UPDATE scheduled_job_claim SET state = 'retry'"))).rejects.toThrow();
  });

  it("hides worker resources from the tenant runtime role", async () => {
    await expect(getWorkerResources(user!.db)).rejects.toThrow();
  });

  it("allows only the original platform owner to enable metered Redis", async () => {
    const db = platformAdmin!.db;
    await expect(updateWorkerResources(db, {
      actorUserId: "wr_delegate", enabled: true, mode: "metered_redis", intervalHours: 1, maxJobs: 60,
      confirmation: "ENABLE METERED REDIS",
    })).rejects.toThrow("resource_owner_required");
    await expect(updateWorkerResources(db, {
      actorUserId: "wr_owner", enabled: true, mode: "metered_redis", intervalHours: 1, maxJobs: 60,
    })).rejects.toThrow("metered_confirmation_required");
    await expect(updateWorkerResources(db, {
      actorUserId: "wr_owner", enabled: true, mode: "free_only", intervalHours: 3, maxJobs: 60,
    })).rejects.toThrow("invalid_resource_settings");
    await updateWorkerResources(db, {
      actorUserId: "wr_owner", enabled: true, mode: "free_only", intervalHours: 2, maxJobs: 30,
    });
    const [row] = await admin!.unsafe("SELECT interval_hours, max_jobs, updated_by FROM worker_resource_settings");
    expect(row).toMatchObject({ interval_hours: 2, max_jobs: 30, updated_by: "wr_owner" });
    const audits = await admin!.unsafe(
      "SELECT action FROM platform_break_glass_audit WHERE actor_user_id = 'wr_owner' AND target_type = 'worker_resource_settings'");
    expect(audits.length).toBeGreaterThan(0);
  });
});
