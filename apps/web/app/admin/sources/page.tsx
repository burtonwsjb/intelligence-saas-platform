import { collectSystemHealth } from "@isp/db";
import { requireGrantedOperator } from "@/lib/platform-admin";
import { getDb } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AdminSourcesPage() {
  const operator = await requireGrantedOperator();
  const health = await collectSystemHealth(operator.adminDb ?? getDb());

  return (
    <>
      <h1>Source health</h1>
      <p className="muted">
        Connector status and ingest counts. Raw source payloads are not shown on this page.
      </p>
      <h2>Platforms</h2>
      <ul>
        {health.platforms.map((row) => (
          <li key={row.sourceType}>
            {row.sourceType}: {row.status}
          </li>
        ))}
      </ul>
      <h2>Source definitions</h2>
      <ul>
        {health.sourceDefinitions.map((row) => (
          <li key={row.sourceKey}>
            {row.sourceKey} · {row.sourceType} · {row.status}
          </li>
        ))}
      </ul>
      <h2>Ingest status</h2>
      <ul>
        {health.ingestByStatus.map((row) => (
          <li key={row.key}>
            {row.key}: {row.count}
          </li>
        ))}
      </ul>
      <p>Market quarantine rows: {health.catalogs.marketQuarantine}</p>
      <p>Webhook endpoints with failures: {health.catalogs.failingWebhooks}</p>
    </>
  );
}
