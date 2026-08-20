import { EmptyState } from "@/components/EmptyState";
import { IdentityLine } from "@/components/IdentityLine";
import { loadAppAccess } from "@/lib/app-access";
import { getDb } from "@/lib/auth";
import { markAllReadAction } from "@/app/notification-actions";
import {
  countCatalog,
  listAlertRules,
  listInAppNotifications,
  listIndexOverview,
  listLatestOpportunities,
  listRecentCreatorCalls,
  withOrganizationContext,
} from "@isp/db";
import { evaluateQuota } from "@isp/billing";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const { organizationId, userId, access } = await loadAppAccess();
  const data = await withOrganizationContext(getDb(), { organizationId, userId }, async (scoped) => {
    const [catalog, opportunities, calls, indices, notices, usage, watches] = await Promise.all([
      countCatalog(getDb()),
      listLatestOpportunities(getDb(), { limit: 5 }),
      listRecentCreatorCalls(getDb(), 5),
      listIndexOverview(getDb()),
      listInAppNotifications(scoped, { organizationId, userId, limit: 5 }),
      evaluateQuota(scoped, { organizationId, meterKey: "api.reads" }),
      listAlertRules(scoped, organizationId),
    ]);
    return { catalog, opportunities, calls, indices, notices, usage, watches };
  });
  const riskAlerts = data.opportunities.filter((row) => Number(row.score.riskScore) >= 60);
  const movers = data.opportunities.slice(0, 3);

  return (
    <>
      <h1>Overview</h1>
      <p className="muted">
        Market catalog: {data.catalog.printings} printings · {data.catalog.scores} score snapshots. Exact language and
        variant stay visible on every printing.
      </p>
      <section>
        <h2>Top opportunities</h2>
        {data.opportunities.length === 0 ? (
          <EmptyState
            title="No scored printings yet"
            body="Local fixtures or ingest jobs populate opportunities. Identity is never collapsed to name-only."
          />
        ) : (
          <ul>
            {data.opportunities.map((row) => (
              <li key={row.score.id}>
                <Link href={`/app/opportunities/${row.identity.printingId}`}>
                  <IdentityLine identity={row.identity} />
                </Link>
                {" — "}
                opportunity {Number(row.score.opportunityScore).toFixed(1)} · {row.score.recommendation}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2>Risk alerts</h2>
        {riskAlerts.length === 0 ? (
          <p className="muted">No high-risk scored printings in the current snapshot.</p>
        ) : (
          <ul>
            {riskAlerts.map((row) => (
              <li key={row.score.id}>
                <IdentityLine identity={row.identity} /> — risk {Number(row.score.riskScore).toFixed(1)}
              </li>
            ))}
          </ul>
        )}
      </section>
      {access.hasCreatorAnalytics ? (
        <section>
          <h2>Recent creator calls</h2>
          {data.calls.length === 0 ? (
            <p className="muted">No creator calls in the local catalog.</p>
          ) : (
            <ul>
              {data.calls.map((call) => (
                <li key={call.id}>
                  {call.direction} · {call.horizonCode} · {call.publishedAt.toISOString()}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      <section>
        <h2>Market movers / indices</h2>
        {movers.length === 0 && data.indices.length === 0 ? (
          <p className="muted">No index levels or scored movers yet.</p>
        ) : (
          <ul>
            {data.indices.map((row) => (
              <li key={row.definition.indexKey}>
                <Link href={`/app/indices/${encodeURIComponent(row.definition.indexKey)}`}>
                  {row.definition.name}
                </Link>
                {row.latest ? ` · ${Number(row.latest.indexValue).toFixed(2)}` : " · no level"}
                {row.definition.languageCode ? ` · ${row.definition.languageCode}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2>Watch items</h2>
        {data.watches.length === 0 ? (
          <p className="muted">Alert rules become watch items. Create them under Alerts when entitled.</p>
        ) : (
          <ul>
            {data.watches.map((rule) => (
              <li key={rule.id}>
                {rule.ruleType} · {rule.enabled ? "on" : "off"} · {rule.channelPreference}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2>Usage</h2>
        <p>
          API reads this period: {data.usage.current} /{" "}
          {Number.isFinite(data.usage.limit) ? data.usage.limit : "unlimited"} remaining {data.usage.remaining}
        </p>
      </section>
      <section>
        <h2>Account notices</h2>
        {data.notices.length === 0 ? (
          <p className="muted">No in-app notifications.</p>
        ) : (
          <>
            <ul>
              {data.notices.map((notice) => (
                <li key={notice.id}>
                  {notice.title} — {notice.body}
                </li>
              ))}
            </ul>
            <form action={markAllReadAction}>
              <button type="submit">Mark all read</button>
            </form>
          </>
        )}
      </section>
      {access.hasPredictionsEntitlement && access.predictionsCustomerVisible ? (
        <p className="muted">Customer prediction views are enabled for this tenant.</p>
      ) : (
        <p className="muted">
          Predictions stay in shadow mode. Customer forecast UI is disabled unless entitled and
          PREDICTIONS_CUSTOMER_VISIBLE=true.
        </p>
      )}
    </>
  );
}
