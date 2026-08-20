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
      <p className="muted">Explainable catalog and ingest counts. No opaque scoring.</p>
      <ul>
        {Object.entries(health.catalogs).map(([key, value]) => (
          <li key={key}>
            {key}: {value}
          </li>
        ))}
      </ul>
    </>
  );
}
