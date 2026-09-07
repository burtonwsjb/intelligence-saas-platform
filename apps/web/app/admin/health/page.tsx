import { collectSystemHealth, getWorkerHeartbeat } from "@isp/db";
import { readQueueFailureSnapshot } from "@isp/shared";
import { requireGrantedOperator } from "@/lib/platform-admin";
import { getDb } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AdminHealthPage() {
  const operator = await requireGrantedOperator();
  const db = operator.adminDb ?? getDb();
  const [health, heartbeat] = await Promise.all([collectSystemHealth(db), getWorkerHeartbeat(db)]);
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
