import { callDirectionText, callHorizonText } from "@/components/CallOutcome";
import { KpiTile, MarketPulse, QuickLink, SignalList } from "@/components/Dashboard";
import { EmptyState } from "@/components/EmptyState";
import { Icon } from "@/components/Icon";
import { loadAppAccess, requireAppActor } from "@/lib/app-access";
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

const SIGNAL_LIMIT = 5;
const UPDATES_LIMIT = 5;

type Update = { id: string; at: Date; title: string; body: string; href?: string };

/**
 * A short daily briefing with a fixed number of regions and items, so the page
 * stays the same height however large the catalog grows. Each region links to
 * the destination that holds the full list.
 */
export default async function OverviewPage() {
  const [{ organizationId, userId, access, unread }, { session }] = await Promise.all([loadAppAccess(), requireAppActor()]);
  const firstName = (session.user.name ?? "").trim().split(/\s+/)[0] || null;
  const scoped = await withOrganizationContext(getDb(), { organizationId, userId }, async (db) => {
    const [notices, watches] = await Promise.all([
      listInAppNotifications(db, { organizationId, userId, limit: UPDATES_LIMIT }),
      access.hasAlerts ? listAlertRules(db, organizationId) : Promise.resolve([]),
    ]);
    return { notices, watches };
  });
  // Three small explorer reads: the strongest buys, the strongest sells, and a
  // count-only read of holds, which together give the market pulse.
  const [catalog, buys, sells, holds, calls] = access.canViewAnalytics
    ? await Promise.all([
        countCatalog(getDb()),
        listCardExplorerPage(getDb(), { ...parseExplorerQuery({ market: "buy", sort: "market_buy" }), pageSize: SIGNAL_LIMIT }),
        listCardExplorerPage(getDb(), { ...parseExplorerQuery({ market: "sell", sort: "market_sell" }), pageSize: SIGNAL_LIMIT }),
        listCardExplorerPage(getDb(), { ...parseExplorerQuery({ market: "hold" }), pageSize: 1 }),
        access.hasCreatorAnalytics ? listRecentCreatorCalls(getDb(), UPDATES_LIMIT) : Promise.resolve([]),
      ])
    : [null, null, null, null, []];

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
      title: `${call.creatorName ?? "A creator"}: ${callDirectionText(call.direction).toLowerCase()}`,
      body: `Judged ${callHorizonText(call.horizonCode)}`,
      href: call.printingId ? `/app/cards/${encodeURIComponent(call.printingId)}?tab=creators` : `/app/creators/${encodeURIComponent(call.creatorId)}`,
    })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, UPDATES_LIMIT);
  const activeWatches = scoped.watches.filter((rule) => rule.enabled).length;

  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/Phoenix" });

  return (
    <>
      <header className="dash-hero">
        <div>
          <p className="eyebrow">{today}</p>
          <h1>{firstName ? `Welcome back, ${firstName}` : "Welcome back"}</h1>
          <p className="muted">Here is how the card market reads today, and what changed since you last looked.</p>
        </div>
        <div className="dash-hero-actions">
          <Link className="button secondary" href="/app/topics">
            <Icon name="plus" size={16} />
            Track a topic
          </Link>
          <Link className="button" href="/app/cards">
            <Icon name="cards" size={16} />
            Browse cards
          </Link>
        </div>
      </header>

      <div className="kpi-row">
        {catalog ? (
          <>
            <KpiTile icon="cards" label="Cards tracked" value={catalog.printings.toLocaleString("en-US")} note="Every exact printing" href="/app/cards" />
            <KpiTile
              icon="arrowUp"
              tone="buy"
              label="Buy signals"
              value={buys!.total.toLocaleString("en-US")}
              note="Strong buy or buy"
              href="/app/cards?market=buy&sort=market_buy"
            />
            <KpiTile
              icon="arrowDown"
              tone="sell"
              label="Sell signals"
              value={sells!.total.toLocaleString("en-US")}
              note="Sell, strong sell or reduce"
              href="/app/cards?market=sell&sort=market_sell"
            />
          </>
        ) : null}
        {access.hasAlerts ? (
          <KpiTile icon="watch" tone="neutral" label="Watch rules on" value={activeWatches} note="Alerts you set" href="/app/alerts" />
        ) : (
          <KpiTile icon="bell" tone="neutral" label="Unread updates" value={unread} note="Notifications and calls" />
        )}
      </div>

      {buys && sells && holds ? (
        <>
          <MarketPulse buy={buys.total} hold={holds.total} sell={sells.total} />
          <div className="dash-grid two">
            <section className="dash-card" aria-labelledby="buys-heading">
              <div className="dash-card-head">
                <div>
                  <h2 id="buys-heading">
                    <span className="head-dot buy" aria-hidden="true" />
                    Strongest buy signals
                  </h2>
                  <p className="subtle">Highest buy readings, weighted by creator accuracy and price</p>
                </div>
                <Link className="text-link" href="/app/cards?market=buy&sort=market_buy">
                  View all
                </Link>
              </div>
              <SignalList rows={buys.rows} empty="No card reads as a buy right now." />
            </section>
            <section className="dash-card" aria-labelledby="sells-heading">
              <div className="dash-card-head">
                <div>
                  <h2 id="sells-heading">
                    <span className="head-dot sell" aria-hidden="true" />
                    Strongest sell signals
                  </h2>
                  <p className="subtle">Cards the market and creators lean against</p>
                </div>
                <Link className="text-link" href="/app/cards?market=sell&sort=market_sell">
                  View all
                </Link>
              </div>
              <SignalList rows={sells.rows} empty="No card reads as a sell right now." />
            </section>
          </div>
        </>
      ) : (
        <EmptyState
          title="Market analytics are not part of your role"
          body="Ask a workspace owner or admin for analytics access to see buy and sell signals."
        />
      )}

      <div className="dash-grid wide-left">
        <section className="dash-card" aria-labelledby="updates-heading">
          <div className="dash-card-head">
            <div>
              <h2 id="updates-heading">Latest activity</h2>
              <p className="subtle">Notifications and new creator calls</p>
            </div>
            {scoped.notices.some((notice) => !notice.readAt) ? (
              <form action={markAllReadAction}>
                <button className="link-button text-link" type="submit">
                  Mark all read
                </button>
              </form>
            ) : null}
          </div>
          {updates.length === 0 ? (
            <div className="activity-empty">
              <Icon name="bell" size={22} />
              <p>You are all caught up. New calls and alerts will show up here.</p>
            </div>
          ) : (
            <ul className="activity-list">
              {updates.map((update) => (
                <li key={update.id}>
                  <span className="activity-dot" aria-hidden="true" />
                  <span className="activity-main">
                    {update.href ? <Link href={update.href}>{update.title}</Link> : <strong>{update.title}</strong>}
                    <span className="subtle">{update.body}</span>
                  </span>
                  <span className="subtle activity-age">{formatAge(update.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="dash-card" aria-labelledby="shortcuts-heading">
          <div className="dash-card-head">
            <div>
              <h2 id="shortcuts-heading">Shortcuts</h2>
              <p className="subtle">Jump straight to the work</p>
            </div>
          </div>
          <div className="quick-links">
            <QuickLink href="/app/cards?view=opportunities" icon="sparkle" title="Opportunities" body="Opportunity 60+ with enough evidence" />
            {access.hasCreatorAnalytics ? (
              <QuickLink href="/app/creators" icon="creators" title="Influencer leaderboard" body="Who calls the market best" />
            ) : null}
            <QuickLink href="/app/markets" icon="markets" title="Markets" body="Sets, sealed and index moves" />
            <QuickLink href="/app/topics" icon="topics" title="Your topics" body="What you asked Sentiment to follow" />
          </div>
        </section>
      </div>
    </>
  );
}
