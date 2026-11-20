import { notFound } from "next/navigation";
import { EmptyState } from "@/components/EmptyState";
import { isPlatformOperatorUser } from "@/lib/platform-admin";
import { requireAppActor } from "@/lib/app-access";
import { loadAppAccess } from "@/lib/app-access";
import { getDb } from "@/lib/auth";
import { listUsageWarnings, withOrganizationContext } from "@isp/db";
import { evaluateQuota, loadEntitlement, type EntitlementKey } from "@isp/billing";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

const METERS = ["api.reads", "ingest.events", "opportunity.read"] as const;

export default async function UsagePage() {
  const { organizationId, userId } = await loadAppAccess();
  // API meters and limits: admin only (owner 2026-11-20).
  const { session } = await requireAppActor();
  if (!(await isPlatformOperatorUser(session.user))) {
    notFound();
  }
  const snapshot = await withOrganizationContext(getDb(), { organizationId, userId }, async (scoped) => {
    const usage = await Promise.all(
      METERS.map(async (meter) => ({
        meter,
        quota: await evaluateQuota(scoped, { organizationId, meterKey: meter }),
      })),
    );
    const limits = await Promise.all(
      (["api_requests_per_month", "api_keys", "webhooks", "alerts", "predictions"] as EntitlementKey[]).map(
        async (key) => ({ key, value: await loadEntitlement(scoped, organizationId, key) }),
      ),
    );
    const warnings = await listUsageWarnings(scoped, organizationId);
    return { usage, limits, warnings };
  });

  return (
    <>
      <h1>Usage</h1>
      <p className="muted">Current period meters, plan limits, remaining quota, and de-duplicated usage warnings.</p>
      <h2>Meters</h2>
      <ul>
        {snapshot.usage.map((row) => (
          <li key={row.meter}>
            {row.meter}: {row.quota.current} / {Number.isFinite(row.quota.limit) ? row.quota.limit : "unlimited"} (
            {row.quota.remaining} remaining)
          </li>
        ))}
      </ul>
      <h2>Plan limits</h2>
      <ul>
        {snapshot.limits.map((row) => (
          <li key={row.key}>
            {row.key}: {row.value.enabled ? "enabled" : "disabled"}
            {row.value.kind === "limit" ? ` · limit ${row.value.limit}` : ""}
          </li>
        ))}
      </ul>
      <h2>Warnings</h2>
      {snapshot.warnings.length === 0 ? (
        <EmptyState title="No usage warnings this period" body="Warnings fire at 50/80/90/100% and do not duplicate." />
      ) : (
        <ul>
          {snapshot.warnings.map((row) => (
            <li key={`${row.meterKey}-${row.thresholdPct}-${row.periodStart.toISOString()}`}>
              {row.meterKey} · {row.thresholdPct}% · {row.periodStart.toISOString()}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
