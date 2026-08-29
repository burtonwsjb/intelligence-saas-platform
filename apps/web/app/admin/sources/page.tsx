import { collectSystemHealth, listAdminProviders } from "@isp/db";
import { requireGrantedOperator } from "@/lib/platform-admin";
import { getDb } from "@/lib/auth";
import {
  retryProviderJobAction,
  setProviderEnabledAction,
  setProviderPausedAction,
  triggerProviderSyncAction,
} from "@/app/admin-actions";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function AdminSourcesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const operator = await requireGrantedOperator();
  const query = await searchParams;
  const db = operator.adminDb ?? getDb();
  const [health, providers] = await Promise.all([collectSystemHealth(db), listAdminProviders(db)]);

  return (
    <>
      <h1>Sources</h1>
      <p className="muted">
        Provider runtime, credentials status (never secret values), health, and staging sync.{" "}
        <Link href="/admin/quarantine">Quarantine</Link>
      </p>
      {query.error ? <p className="form-error">Source control was rejected.</p> : null}
      {providers.map((row) => (
        <section key={row.providerKey}>
          <h2>{row.providerKey}</h2>
          <p>
            {row.providerType} · mode {row.mode} · {row.enabled ? "enabled" : "disabled"} ·{" "}
            {row.paused ? "paused" : "active"} · credentials {row.credentialStatus} · health {row.healthStatus}
          </p>
          <p className="muted">
            last success {row.lastSuccessAt?.toISOString() ?? "—"} · last attempt {row.lastAttemptAt?.toISOString() ?? "—"} ·
            error {row.lastErrorClass ?? "—"} · rate remaining {row.rateLimitRemaining ?? "—"} · ingested{" "}
            {row.recordsIngested} · quarantined {row.recordsQuarantined} · cursor {row.lastSourceId ?? "—"} · schedule{" "}
            {row.scheduleSeconds}s
          </p>
          <form className="inline-form" action={setProviderEnabledAction}>
            <input type="hidden" name="providerKey" value={row.providerKey} />
            <input type="hidden" name="enabled" value={row.enabled ? "false" : "true"} />
            <label>
              Reason
              <input name="reason" required />
            </label>
            <button type="submit">{row.enabled ? "Disable" : "Enable"}</button>
          </form>
          <form className="inline-form" action={setProviderPausedAction}>
            <input type="hidden" name="providerKey" value={row.providerKey} />
            <input type="hidden" name="paused" value={row.paused ? "false" : "true"} />
            <label>
              Reason
              <input name="reason" required />
            </label>
            <button type="submit">{row.paused ? "Resume" : "Pause"}</button>
          </form>
          <form className="inline-form" action={triggerProviderSyncAction}>
            <input type="hidden" name="providerKey" value={row.providerKey} />
            <label>
              Confirm staging sync
              <input type="checkbox" name="confirm" value="yes" required />
            </label>
            <button type="submit">Trigger staging sync</button>
          </form>
        </section>
      ))}
      <h2>Retry failed job</h2>
      <form className="inline-form" action={retryProviderJobAction}>
        <label>
          Job id
          <input name="jobId" required />
        </label>
        <label>
          Reason
          <input name="reason" required />
        </label>
        <button type="submit">Retry</button>
      </form>
      <h2>Ingest status</h2>
      <ul>
        {health.ingestByStatus.map((row) => (
          <li key={row.key}>
            {row.key}: {row.count}
          </li>
        ))}
      </ul>
    </>
  );
}
