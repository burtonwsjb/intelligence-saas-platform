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
      <ul>
        {health.providers.map((row) => (
          <li key={row.provider}>
            {row.provider}: {row.mode}/{row.health} · last sync {row.lastSuccessAt ?? "—"} · rate{" "}
            {row.rateLimitRemaining ?? "—"}
          </li>
        ))}
      </ul>
    </>
  );
}
