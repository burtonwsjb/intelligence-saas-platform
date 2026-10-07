import { CardTile } from "@/components/CardTile";
import { CompactStat } from "@/components/CompactStat";
import { EmptyState } from "@/components/EmptyState";
import { loadAppAccess } from "@/lib/app-access";
import { getDb } from "@/lib/auth";
import { formatAge } from "@/lib/display";
import { markAllReadAction } from "@/app/notification-actions";
import {
  countCatalog,
  listAlertRules,
  listCardExplorerPage,
  listInAppNotifications,
  listRecentCreatorCalls,
  parseExplorerQuery,
  withOrganizationContext,
} from "@isp/db";
import Link from "next/link";

export const dynamic = "force-dynamic";

const FEATURED_LIMIT = 8;
const UPDATES_LIMIT = 5;

type Update = { id: string; at: Date; title: string; body: string; href?: string };

/**
 * A short daily briefing with a fixed number of regions and items, so the page
 * stays the same height however large the catalog grows. Each region links to
 * the destination that holds the full list.
 */
export default async function OverviewPage() {
  const { organizationId, userId, access, unread } = await loadAppAccess();
  const scoped = await withOrganizationContext(getDb(), { organizationId, userId }, async (db) => {
    const [notices, watches] = await Promise.all([
      listInAppNotifications(db, { organizationId, userId, limit: UPDATES_LIMIT }),
      access.hasAlerts ? listAlertRules(db, organizationId) : Promise.resolve([]),
    ]);
    return { notices, watches };
  });
  const [catalog, featured, calls] = access.canViewAnalytics
    ? await Promise.all([
        countCatalog(getDb()),
        listCardExplorerPage(getDb(), { ...parseExplorerQuery({ view: "opportunities" }), pageSize: FEATURED_LIMIT }),
        access.hasCreatorAnalytics ? listRecentCreatorCalls(getDb(), UPDATES_LIMIT) : Promise.resolve([]),
      ])
    : [null, null, []];

  const updates: Update[] = [
    ...scoped.notices.map((notice) => ({
      id: `n-${notice.id}`,
      at: notice.createdAt,
      title: notice.title,
      body: notice.body,
    })),
    ...calls.map((call) => ({
      id: `c-${call.id}`,
      at: call.publishedAt,
      title: `${call.creatorName ?? "A creator"} made a ${call.direction.replaceAll("_", " ")} call`,
      body: `Horizon ${call.horizonCode.replaceAll("_", " ")}`,
      href: call.printingId ? `/app/cards/${encodeURIComponent(call.printingId)}?tab=creators` : `/app/creators/${encodeURIComponent(call.creatorId)}`,
    })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, UPDATES_LIMIT);
  const activeWatches = scoped.watches.filter((rule) => rule.enabled).length;

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Overview</p>
          <h1>Today’s briefing</h1>
          <p className="muted">What scored highest, what changed, and what needs your attention.</p>
        </div>
      </header>

      <div className="stat-row">
        {catalog ? (
          <>
            <CompactStat label="Printings tracked" value={catalog.printings.toLocaleString("en-US")} href="/app/cards" />
            <CompactStat
              label="Meeting the opportunity view"
              value={featured!.total.toLocaleString("en-US")}
              note="Opportunity 60+ with enough evidence"
              href="/app/cards?view=opportunities"
            />
          </>
        ) : null}
        <CompactStat label="Unread updates" value={unread} />
        {access.hasAlerts ? (
          <CompactStat label="Active watch rules" value={activeWatches} href="/app/alerts" />
        ) : null}
      </div>

      {featured ? (
        <section aria-labelledby="featured-heading">
          <div className="section-head">
            <h2 id="featured-heading">Highest opportunity scores</h2>
            <Link className="text-link" href="/app/cards?view=opportunities">
              View all
            </Link>
          </div>
          {featured.rows.length === 0 ? (
            <EmptyState
              title="Nothing meets the opportunity view yet"
              body="No scored printing currently has an opportunity score of 60 or more with enough evidence. Browse the full catalog instead."
              action={
                <Link className="text-link" href="/app/cards">
                  Browse all cards
                </Link>
              }
            />
          ) : (
            <ul className="card-grid">
              {featured.rows.map((row) => (
                <li key={row.printingId}>
                  <CardTile row={row} href={`/app/cards/${encodeURIComponent(row.printingId)}`} windowLabel="30d" />
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section aria-labelledby="updates-heading">
        <div className="section-head">
          <h2 id="updates-heading">Latest updates</h2>
          {scoped.notices.some((notice) => !notice.readAt) ? (
            <form action={markAllReadAction}>
              <button className="link-button text-link" type="submit">
                Mark all read
              </button>
            </form>
          ) : null}
        </div>
        <div className="panel">
          {updates.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              No new notifications or creator calls.
            </p>
          ) : (
            <ul className="item-list">
              {updates.map((update) => (
                <li key={update.id}>
                  <span className="item-main">
                    {update.href ? <Link href={update.href}>{update.title}</Link> : <strong>{update.title}</strong>}
                    <span className="subtle">{update.body}</span>
                  </span>
                  <span className="subtle">{formatAge(update.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </>
  );
}
