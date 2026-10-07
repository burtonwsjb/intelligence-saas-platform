import { collectSystemHealth, getWorkerHeartbeat, getWorkerResources, isWorkerResourceOwner } from "@isp/db";
import { FREE_REDIS_POLICY, readQueueFailureSnapshot } from "@isp/shared";
import { requireGrantedOperator } from "@/lib/platform-admin";
import { getDb } from "@/lib/auth";
import { closeInterruptedScheduledRunAction, updateWorkerResourcesAction } from "@/app/admin-actions";

const RESOURCE_NOTICES: Record<string, string> = {
  saved: "Worker resource settings saved.",
  closed: "Interrupted batch closed. No job was replayed.",
  rejected: "Change rejected. Only the original platform owner can change resources, and metered Redis needs the exact confirmation.",
  config: "Worker resources need the platform admin database role.",
};

async function loadWorkerResources(db: Parameters<typeof getWorkerResources>[0], userId: string) {
  try {
    const [resources, owner] = await Promise.all([getWorkerResources(db), isWorkerResourceOwner(db, userId)]);
    return { ...resources, owner };
  } catch {
    // Migration not applied to this database yet. Nothing falls back to Redis.
    return null;
  }
}

export const dynamic = "force-dynamic";

export default async function AdminHealthPage({
  searchParams,
}: {
  searchParams: Promise<{ resources?: string }>;
}) {
  const operator = await requireGrantedOperator();
  const query = await searchParams;
  const db = operator.adminDb ?? getDb();
  const [health, heartbeat, resources] = await Promise.all([
    collectSystemHealth(db),
    getWorkerHeartbeat(db),
    operator.adminDb ? loadWorkerResources(operator.adminDb, operator.session.user.id) : Promise.resolve(null),
  ]);
  const queueFailureSample = readQueueFailureSnapshot(heartbeat?.metadata?.queue_failure_sample);

  return (
    <>
      <h1>System health</h1>
      <p className="muted">Operational states. Secrets are never displayed.</p>
      <h2>Overall</h2>
      <p>
        <strong>{health.status}</strong>
      </p>
      <p className="muted">{health.guidance}</p>
      <h2>Catalogs</h2>
      <ul>
        {Object.entries(health.catalogs).map(([key, value]) => (
          <li key={key}>
            {key}: {value}
          </li>
        ))}
      </ul>
      <h2>Operations</h2>
      <ul>
        {Object.entries(health.operations).map(([key, value]) => (
          <li key={key}>
            {key}: {String(value)}
          </li>
        ))}
      </ul>
      <h2>Worker resources</h2>
      <p className="muted">
        Hosted workers drain the database outbox in bounded batches on Phoenix time (hourly by default, quiet
        02:00-06:00) and use no Redis commands. A metered Redis window reserves {FREE_REDIS_POLICY.batchCommandAllowance}{" "}
        commands and stops at {FREE_REDIS_POLICY.dailyCommandAllowance.toLocaleString("en-US")} a day or{" "}
        {FREE_REDIS_POLICY.monthlyCommandCeiling.toLocaleString("en-US")} a month.
      </p>
      {query.resources && RESOURCE_NOTICES[query.resources] ? <p role="status">{RESOURCE_NOTICES[query.resources]}</p> : null}
      {!resources ? <p>Worker resource settings are not available on this database yet.</p> : (
        <>
          <p>
            {resources.settings.enabled ? "Enabled" : "Paused"} · {resources.settings.mode === "free_only" ? "free only (no Redis)" : "metered Redis"} ·
            every {resources.settings.interval_hours}h · up to {resources.settings.max_jobs} jobs per batch
          </p>
          {resources.owner ? (
            <form className="inline-form" action={updateWorkerResourcesAction}>
              <label>
                Schedule
                <select name="enabled" defaultValue={String(resources.settings.enabled)}>
                  <option value="true">enabled</option>
                  <option value="false">paused</option>
                </select>
              </label>
              <label>
                Mode
                <select name="mode" defaultValue={resources.settings.mode}>
                  <option value="free_only">free only</option>
                  <option value="metered_redis">metered Redis</option>
                </select>
              </label>
              <label>
                Every
                <select name="intervalHours" defaultValue={String(resources.settings.interval_hours)}>
                  <option value="1">1 hour</option>
                  <option value="2">2 hours</option>
                  <option value="4">4 hours</option>
                </select>
              </label>
              <label>
                Jobs per batch
                <input name="maxJobs" type="number" min={1} max={60} defaultValue={resources.settings.max_jobs} />
              </label>
              <label>
                Type ENABLE METERED REDIS to allow Redis
                <input name="confirmation" autoComplete="off" />
              </label>
              <button type="submit">Save</button>
            </form>
          ) : <p className="muted">Only the original platform owner can change these settings.</p>}
          <h3>Recent batches</h3>
          {resources.runs.length === 0 ? <p>No batches yet.</p> : resources.runs.map((run) => (
            <section key={run.id}>
              <p>{run.slot} · {run.mode} · {run.status} · attempted {run.attempted} · processed {run.processed} · failures {run.failures}</p>
              {resources.owner && (run.status === "running" || run.status === "indeterminate") ? (
                <form className="inline-form" action={closeInterruptedScheduledRunAction}>
                  <input type="hidden" name="runId" value={run.id} />
                  <label>
                    After confirming the worker stopped, type WORKER STOPPED
                    <input name="confirmation" autoComplete="off" required />
                  </label>
                  <button type="submit">Close batch without replay</button>
                </form>
              ) : null}
            </section>
          ))}
        </>
      )}
      <h2>Retained queue failures</h2>
      <p className="muted">Read-only sample from Redis, separate from database outbox counts. No jobs are retried or deleted by this page. A referenced table does not establish the failure cause.</p>
      {!queueFailureSample ? <p>No inspection available yet.</p> : (
        <>
          <p>Inspection: {queueFailureSample.status} · sampled at {queueFailureSample.sampledAt}</p>
          {Date.now() - Date.parse(queueFailureSample.sampledAt) > 600_000 ? <p role="status">This sample is over ten minutes old. It does not describe the current queue.</p> : null}
          <p>Retained at inspection: {queueFailureSample.retainedCountAtRead ?? "unknown"} · sampled: {queueFailureSample.sampledJobs} · limit: {queueFailureSample.sampleLimit} · partial sample: {String(queueFailureSample.truncated)}</p>
          {queueFailureSample.errorClass ? <p>Inspection error: {queueFailureSample.errorClass}</p> : null}
          {queueFailureSample.groups.map((group) => (
            <section key={`${group.jobType}:${group.errorClass}:${group.queryTable}`}>
              <p>{group.jobType} · {group.errorClass} · {group.count} jobs · referenced table: {group.queryTable ?? "not identified"}</p>
              <p className="muted">Earliest failure: {group.earliestFinishedAt ?? "unknown"} · latest: {group.latestFinishedAt ?? "unknown"} · maximum attempts: {group.maxAttemptsMade}</p>
            </section>
          ))}
        </>
      )}
      <h2>Providers</h2>
      {health.providers.length === 0 ? (
        <p className="muted">No provider runtime rows.</p>
      ) : (
        <ul>
          {health.providers.map((row) => (
            <li key={row.provider}>
              {row.provider}: {row.mode}/{row.health}
              {row.paused ? " · paused" : ""}
              {row.enabled ? "" : " · disabled"} · last sync {row.lastSuccessAt ?? "—"} · retry-after{" "}
              {row.retryAfterAt ?? "—"} · rate {row.rateLimitRemaining ?? "—"}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
