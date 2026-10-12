import {
  createDbConnection, requireWorkerDatabaseUrl, getWorkerResources, claimScheduledRun,
  claimScheduledJob, finishScheduledJob, finishScheduledRun, enqueueDueProviderSyncs,
  applyProviderModeFromEnv, recordScheduledWorkerState, withPlatformContext,
  type Database, type ScheduledRun, type ScheduledJob,
} from "@isp/db";
import { nextScheduledAt, scheduledSlot, SCHEDULE_DEFAULTS } from "@isp/shared";
import { processNormalizeJob, parseJobEnvelope, UnrecoverableJobError, withMeteredRedisPermission } from "@isp/queue";
import type { WorkerDiagnostics } from "./worker.js";

type Handle = { stop: () => Promise<void>; diagnostics: () => WorkerDiagnostics; isShuttingDown: () => boolean };
export type ScheduledCycleDeps = {
  claimRun: () => Promise<ScheduledRun | null>;
  claimJob: (runId: string) => Promise<ScheduledJob | null>;
  process: (job: ScheduledJob) => Promise<unknown>;
  finishJob: (runId: string, job: ScheduledJob, state: "processed" | "retry" | "failed" | "indeterminate", error?: string) => Promise<unknown>;
  finishRun: (runId: string, state: "completed" | "failed" | "indeterminate", error?: string) => Promise<unknown>;
  prepare: () => Promise<void>;
  metered: (run: ScheduledRun) => Promise<void>;
  now: () => Date;
  stopping: () => boolean;
  jobTimeoutMs?: number;
};
/** No queue transport in the free path. Reuses the exact canonical job handler.
 * An uncertain timeout blocks further processing; it is never blindly retried.
 */
export async function executeScheduledCycle(deps: ScheduledCycleDeps): Promise<string> {
  if (deps.stopping() || !scheduledSlot(deps.now())) return "outside_window";
  const run = await deps.claimRun();
  if (!run) return "not_admitted";
  let status: "completed" | "failed" | "indeterminate" = "completed";
  try {
    if (run.mode === "metered_redis") {
      await deps.metered(run);
      return "completed";
    }
    await deps.prepare();
    for (let i = 0; i < Math.min(run.max_jobs, SCHEDULE_DEFAULTS.maxJobs); i++) {
      if (deps.stopping() || deps.now().getTime() >= new Date(run.deadline_at).getTime()) break;
      const job = await deps.claimJob(run.id);
      if (!job) break;
      // Bind the worker envelope to the durable record, not caller-supplied IDs.
      let envelope;
      try {
        envelope = parseJobEnvelope(job.payload);
        if (envelope.job_id !== job.job_id
          || (job.kind === "tenant" && (envelope.job_type !== "source_event.normalize" || envelope.organization_id !== job.organization_id))
          || (job.kind === "platform" && envelope.job_type === "source_event.normalize")) throw new Error("invalid_job_scope");
      } catch {
        await deps.finishJob(run.id, job, "failed", "invalid_job_scope");
        continue;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = Symbol("timeout");
      try {
        const result = await Promise.race([
          deps.process(job),
          new Promise<typeof timeout>((resolve) => {
            timer = setTimeout(() => resolve(timeout), deps.jobTimeoutMs ?? 90_000);
          }),
        ]);
        if (result === timeout) {
          status = "indeterminate";
          await deps.finishJob(run.id, job, "indeterminate", "processing_timeout");
          break; // Promise timeout is NOT cancellation. Never start overlapping work.
        }
        await deps.finishJob(run.id, job, "processed");
      } catch (error) {
        await deps.finishJob(run.id, job,
          error instanceof UnrecoverableJobError || job.attempt >= 3 ? "failed" : "retry", "processing_failed");
      } finally { if (timer !== undefined) clearTimeout(timer); }
    }
    return status;
  } catch {
    // Unknown commit/connection state requires review instead of replaying.
    status = "indeterminate";
    return status;
  } finally { await deps.finishRun(run.id, status, status === "completed" ? undefined : "batch_requires_review"); }
}

export function startScheduledWorker(options: {
  db?: Database; env: NodeJS.ProcessEnv; afterBatch?: (db: Database) => Promise<void>; startMetered: (env: NodeJS.ProcessEnv, db: Database) => Handle;
}): Handle {
  const startedAt = new Date().toISOString();
  let status: WorkerDiagnostics["status"] = "running";
  let lastHeartbeat: string | null = null;
  let lastError: string | null = null;
  let nextAt = nextScheduledAt(new Date());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  let metered: Handle | undefined;
  let intervalHours = 1;
  const stopping = () => status === "shutting_down" || status === "stopped";
  const cycle = async () => {
    let owned: ReturnType<typeof createDbConnection> | undefined;
    try {
      owned = options.db ? undefined : createDbConnection(requireWorkerDatabaseUrl(options.env));
      const db = options.db ?? owned!.db;
      const { settings } = await getWorkerResources(db);
      intervalHours = settings.interval_hours;
      const outcome = await executeScheduledCycle({
        now: () => new Date(), stopping,
        claimRun: () => claimScheduledRun(db),
        claimJob: (id) => claimScheduledJob(db, id),
        process: (job) => processNormalizeJob(db, job.payload, job.attempt),
        finishJob: (id, job, state, error) => finishScheduledJob(db, id, job, state, error),
        finishRun: (id, state, error) => finishScheduledRun(db, id, state, error),
        prepare: async () => {
          await withPlatformContext(db, async (tx) => {
            await applyProviderModeFromEnv(tx, options.env);
            await enqueueDueProviderSyncs(tx, options.env);
          });
        },
        metered: async (run) => withMeteredRedisPermission(db, options.env, new Date(run.deadline_at), async (permitted) => {
          metered = options.startMetered(permitted, db);
          try { await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, new Date(run.deadline_at).getTime() - Date.now()))); }
          finally { await metered.stop(); metered = undefined; }
        }),
      });
      if (settings.enabled && outcome === "completed" && !stopping()) await options.afterBatch?.(db);
      nextAt = nextScheduledAt(new Date(), intervalHours);
      await recordScheduledWorkerState(db, { mode: settings.mode, enabled: settings.enabled,
        nextAt, outcome, intervalHours });
      lastHeartbeat = new Date().toISOString();
      lastError = outcome === "indeterminate" ? "batch_requires_review" : null;
    } catch {
      lastError = "resource_scheduler_unavailable";
      // No Redis fallback on a missing migration, denied permission, or DB error.
      console.error(JSON.stringify({ event: "worker.schedule_unavailable", error_class: lastError }));
    } finally { await owned?.end().catch(() => undefined); }
  };
  const arm = () => {
    if (stopping()) return;
    nextAt = nextScheduledAt(new Date(), intervalHours);
    timer = setTimeout(tick, Math.max(1000, nextAt.getTime() - Date.now()));
  };
  const tick = () => {
    if (stopping() || pending) return;
    pending = cycle().finally(() => { pending = undefined; arm(); });
  };
  if (scheduledSlot(new Date())) tick(); else arm();
  return {
    isShuttingDown: stopping,
    diagnostics: () => ({ status, started_at: startedAt, shutting_down: stopping(),
      last_heartbeat_at: lastHeartbeat, last_heartbeat_error_class: lastError,
      execution_mode: "scheduled", next_scheduled_at: nextAt.toISOString(), time_zone: "America/Phoenix" }),
    stop: async () => {
      status = "shutting_down";
      if (timer !== undefined) clearTimeout(timer);
      if (metered) await metered.stop();
      await pending;
      status = "stopped";
    },
  };
}
