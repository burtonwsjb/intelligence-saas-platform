import { collectSystemHealth, countCustomersByStage, describePlatformConfig } from "@isp/db";
import { getDb } from "@/lib/auth";
import { requirePlatformOperator } from "@/lib/platform-admin";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function AdminOverviewPage() {
  const operator = await requirePlatformOperator();
  if (operator.denied) {
    return null;
  }
  const db = operator.adminDb ?? getDb();
  const [health, stages] = await Promise.all([
    collectSystemHealth(db),
    operator.adminDb ? countCustomersByStage(operator.adminDb) : Promise.resolve([]),
  ]);
  const config = describePlatformConfig();

  return (
    <>
      <h1>Platform admin</h1>
      <p className="muted">
        Operator console. Break-glass tenant inspection is audited. Impersonation does not inherit
        unrestricted database access. Grant source: {operator.access.source}.
      </p>
      <h2>Customers by stage</h2>
      {stages.length === 0 ? (
        <p className="muted">Cross-tenant CRM listings require the app_admin connection.</p>
      ) : (
        <ul>
          {stages.map((row) => (
            <li key={row.lifecycleStage}>
              {row.lifecycleStage}: {row.count}
            </li>
          ))}
        </ul>
      )}
      <h2>Catalog</h2>
      <ul>
        <li>Printings {health.catalogs.printings}</li>
        <li>Creators {health.catalogs.creators}</li>
        <li>Indices {health.catalogs.indices}</li>
        <li>Predictions {health.catalogs.predictions} (shadow by default)</li>
        <li>Market quarantine {health.catalogs.marketQuarantine}</li>
      </ul>
      <p className="muted">
        Runtime {config.nodeEnv} · billing {config.billingMode} · email {config.emailMode}. Secrets
        are never displayed. <Link href="/admin/config">Configuration</Link>
      </p>
    </>
  );
}
