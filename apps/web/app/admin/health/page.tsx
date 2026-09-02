import { collectSystemHealth } from "@isp/db";
import { requireGrantedOperator } from "@/lib/platform-admin";
import { getDb } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AdminHealthPage() {
  const operator = await requireGrantedOperator();
  const health = await collectSystemHealth(operator.adminDb ?? getDb());

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
