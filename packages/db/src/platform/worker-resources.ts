import { sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { withPlatformContext } from "../rls.js";
import { insertBreakGlassAudit } from "./audit.js";

export type WorkerResourceSettings = { id: string; enabled: boolean; mode: "free_only" | "metered_redis";
  interval_hours: number; max_jobs: number; updated_at: Date | string; updated_by: string | null };
export type ScheduledRun = { id: string; mode: "free_only" | "metered_redis"; status: string;
  started_at: Date | string; deadline_at: Date | string; attempted: number; processed: number; failures: number; max_jobs: number };
export type ScheduledJob = { kind: "platform" | "tenant"; job_id: string; organization_id: string | null;
  payload: Record<string, unknown>; attempt: number };
function rows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : result && typeof result === "object" && "rows" in result
    ? (result as { rows: unknown[] }).rows : []) as T[];
}
export async function getWorkerResources(db: Database) {
  return withPlatformContext(db, async (tx) => {
    const settings = rows<WorkerResourceSettings>(await tx.execute(sql`SELECT * FROM worker_resource_settings WHERE id='global'`))[0];
    if (!settings) throw new Error("resource_settings_missing");
    const runs = rows<ScheduledRun>(await tx.execute(sql`SELECT * FROM scheduled_worker_run ORDER BY started_at DESC LIMIT 20`));
    return { settings, runs };
  });
}
/** Only the original platform grant holder can permit additional resource usage.
 * This is independent of workspace-owner roles and delegated platform operators.
 */
export async function isWorkerResourceOwner(db: Database, actorUserId: string): Promise<boolean> {
  const result = await db.execute(sql`SELECT user_id FROM platform_admins WHERE user_id=${actorUserId}
    AND granted_by_user_id IS NULL LIMIT 1`);
  return rows(result).length === 1;
}
export async function updateWorkerResources(db: Database, input: {
  actorUserId: string; enabled: boolean; mode: string; intervalHours: number; maxJobs: number; confirmation?: string;
}) {
  if (!(await isWorkerResourceOwner(db, input.actorUserId))) throw new Error("resource_owner_required");
  if (!["free_only", "metered_redis"].includes(input.mode) || ![1, 2, 4].includes(input.intervalHours)
    || !Number.isInteger(input.maxJobs) || input.maxJobs < 1 || input.maxJobs > 60) throw new Error("invalid_resource_settings");
  if (input.mode === "metered_redis" && input.confirmation !== "ENABLE METERED REDIS") throw new Error("metered_confirmation_required");
  return db.transaction(async (tx) => {
    const updated = rows(await tx.execute(sql`UPDATE worker_resource_settings SET enabled=${input.enabled},mode=${input.mode},
      interval_hours=${input.intervalHours},max_jobs=${input.maxJobs},updated_by=${input.actorUserId},updated_at=now() WHERE id='global' RETURNING id`));
    if (updated.length !== 1) throw new Error("resource_settings_missing");
    await insertBreakGlassAudit(tx, { actorUserId: input.actorUserId, action: "feature.flag", targetType: "worker_resource_settings", targetId: "global",
      metadata: { mode: input.mode, enabled: input.enabled, interval_hours: input.intervalHours, max_jobs: input.maxJobs } });
  });
}
export async function claimScheduledRun(db: Database): Promise<ScheduledRun | null> {
  return withPlatformContext(db, async (tx) => rows<ScheduledRun>(await tx.execute(sql`SELECT * FROM app.claim_scheduled_run()`))[0] ?? null);
}
export async function claimScheduledJob(db: Database, runId: string): Promise<ScheduledJob | null> {
  return withPlatformContext(db, async (tx) => rows<ScheduledJob>(await tx.execute(sql`SELECT * FROM app.claim_scheduled_job(${runId})`))[0] ?? null);
}
export async function finishScheduledJob(db: Database, runId: string, job: ScheduledJob,
  state: "processed" | "retry" | "failed" | "indeterminate", errorClass: string | null = null) {
  return withPlatformContext(db, (tx) => tx.execute(sql`SELECT app.finish_scheduled_job(${runId},${job.kind},${job.job_id},${state},${errorClass})`));
}
export async function finishScheduledRun(db: Database, runId: string, status: "completed" | "failed" | "indeterminate", errorClass: string | null = null) {
  return withPlatformContext(db, (tx) => tx.execute(sql`SELECT app.finish_scheduled_run(${runId},${status},${errorClass})`));
}
/** Merge into the heartbeat: preserve old Redis failure evidence, but never
 * claim it is a freshly measured queue count in zero-Redis scheduled mode. */
export async function recordScheduledWorkerState(db: Database, input: {
  mode: string; enabled: boolean; nextAt: Date; outcome: string; intervalHours: number;
}) {
  const metadata = JSON.stringify({ execution_mode: "scheduled", resource_mode: input.mode,
    schedule_enabled: input.enabled, next_scheduled_at: input.nextAt.toISOString(),
    interval_hours: input.intervalHours, schedule_outcome: input.outcome,
    queue_metrics_error_class: null, queue_metrics_source: "not_polled_resource_protection" });
  return withPlatformContext(db, (tx) => tx.execute(sql`
    INSERT INTO worker_heartbeat(worker_key,last_seen_at,queue_depth,failed_jobs,metadata)
    VALUES('ingest',now(),NULL,NULL,${metadata}::jsonb)
    ON CONFLICT(worker_key) DO UPDATE SET last_seen_at=now(),updated_at=now(),queue_depth=NULL,failed_jobs=NULL,
      metadata=worker_heartbeat.metadata || ${metadata}::jsonb`));
}

/** Operator closes the run lock only after verifying the previous process is
 * stopped. It does not requeue any potentially executed job or erase evidence. */
export async function closeInterruptedScheduledRun(db: Database, input: {
  actorUserId: string; runId: string; confirmation: string;
}) {
  if (!(await isWorkerResourceOwner(db,input.actorUserId)) || input.confirmation !== "WORKER STOPPED") throw new Error("resource_owner_confirmation_required");
  return db.transaction(async (tx) => {
    const updated = rows(await tx.execute(sql`UPDATE scheduled_worker_run
      SET status='failed',error_class='owner_closed_interrupted',completed_at=now()
      WHERE id=${input.runId} AND status IN ('running','indeterminate') AND deadline_at<now()-interval '10 minutes' RETURNING id`));
    if (updated.length !== 1) throw new Error("run_not_recoverable");
    await tx.execute(sql`UPDATE scheduled_job_claim SET state='indeterminate',error_class='owner_closed_interrupted',updated_at=now()
      WHERE run_id=${input.runId} AND state='running'`);
    await insertBreakGlassAudit(tx,{actorUserId:input.actorUserId,action:"feature.flag",targetType:"scheduled_worker_run",targetId:input.runId,
      metadata:{action:"close_interrupted_run",jobs_replayed:0}});
  });
}

/** A transport change must not replay an unresolved or already handled claim. */
export async function scheduledClaimAllowsRedis(db: Database, kind: "platform" | "tenant", jobId: string): Promise<boolean> {
  return withPlatformContext(db, async (tx) => {
    const claim = rows<{state:string}>(await tx.execute(sql`SELECT state FROM scheduled_job_claim WHERE kind=${kind} AND job_id=${jobId} LIMIT 1`))[0];
    return claim === undefined || claim.state === "retry";
  });
}
