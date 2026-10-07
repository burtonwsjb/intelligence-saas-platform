import { EmptyState, LockedFeature } from "@/components/EmptyState";
import { ResultPager } from "@/components/ResultPager";
import { Sparkline } from "@/components/Sparkline";
import { StatusBadge } from "@/components/Badge";
import { ANALYTICS_LOCKED_BODY, loadAppAccess } from "@/lib/app-access";
import { getDb } from "@/lib/auth";
import { dataQualityText, formatAge, formatChange, languageText } from "@/lib/display";
import { listIndexSummaries, listSetSummaries, windowChange } from "@isp/db";
import Link from "next/link";

export const dynamic = "force-dynamic";

const SET_PAGE_SIZE = 12;

export default async function MarketsPage({
  searchParams,
}: {
  searchParams: Promise<{ setPage?: string }>;
}) {
  const { access } = await loadAppAccess();
  if (!access.canViewAnalytics) {
    return <LockedFeature title="Markets" body={ANALYTICS_LOCKED_BODY} />;
  }
  const query = await searchParams;
  const setPage = Math.max(1, Math.min(500, Math.trunc(Number(query.setPage ?? 1)) || 1));
  const [indices, sets] = await Promise.all([
    listIndexSummaries(getDb()),
    listSetSummaries(getDb(), { page: setPage, pageSize: SET_PAGE_SIZE }),
  ]);
  const forecastsVisible = access.hasPredictionsEntitlement && access.predictionsCustomerVisible;

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Markets</p>
          <h1>Market trends</h1>
          <p className="muted">Language-scoped indices and sets. Index levels come from the analytics pipeline’s published method.</p>
        </div>
        {forecastsVisible ? (
          <Link className="button secondary" href="/app/predictions">
            Published forecasts
          </Link>
        ) : null}
      </header>

      <section aria-labelledby="indices-heading">
        <div className="section-head">
          <h2 id="indices-heading">Indices</h2>
        </div>
        {indices.length === 0 ? (
          <EmptyState title="No indices yet" body="Index levels appear once the analytics jobs publish them." />
        ) : (
          <ul className="panel-grid" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {indices.map((index) => {
              const change = formatChange(windowChange(index.levels));
              const quality = index.latest?.dataQuality ? dataQualityText(index.latest.dataQuality) : null;
              return (
                <li key={index.indexKey} className="panel" style={{ position: "relative", margin: 0 }}>
                  <p className="eyebrow">
                    {index.gameKey}
                    {index.languageCode ? ` · ${languageText(index.languageCode)}` : ""}
                  </p>
                  <h3 className="card-title">
                    <Link href={`/app/indices/${encodeURIComponent(index.indexKey)}`}>{index.name}</Link>
                  </h3>
                  <div className="card-price-row" style={{ marginTop: "var(--space-3)" }}>
                    <div className="card-price">
                      <span className="amount">{index.latest ? index.latest.value.toFixed(2) : "No level"}</span>
                      {change ? (
                        <span className={`change ${change.direction}`}>
                          {change.text} <span className="subtle">across shown levels</span>
                        </span>
                      ) : (
                        <span className="subtle">Not enough levels for a change</span>
                      )}
                    </div>
                    {index.levels.length >= 2 ? (
                      <Sparkline values={index.levels.map((level) => level.amount)} label={`${index.name} level trend`} />
                    ) : null}
                  </div>
                  {index.latest ? (
                    <div className="badge-row" style={{ marginTop: "var(--space-3)" }}>
                      <StatusBadge tone="info" label={`Updated ${formatAge(index.latest.observedAt)}`} />
                      {index.latest.coverage ? (
                        <StatusBadge tone="info" label={`Coverage ${Math.round(Number(index.latest.coverage) * 100)}%`} />
                      ) : null}
                      {quality ? <StatusBadge tone={quality.tone} label={quality.label} /> : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="sets-heading">
        <div className="section-head">
          <h2 id="sets-heading">Sets</h2>
          <Link className="text-link" href="/app/cards">
            Browse all cards
          </Link>
        </div>
        {sets.items.length === 0 ? (
          <EmptyState title="No sets in the catalog yet" body="Sets appear as catalog discovery adds them." />
        ) : (
          <div className="panel">
            <ul className="item-list">
              {sets.items.map((set) => (
                <li key={set.setKey}>
                  <span className="item-main">
                    <Link href={`/app/cards?set=${encodeURIComponent(set.setKey)}`}>{set.name}</Link>
                    <span className="subtle">
                      {set.gameKey}
                      {set.languageScope ? ` · ${languageText(set.languageScope)}` : ""}
                      {set.releaseDate ? ` · released ${set.releaseDate}` : ""}
                    </span>
                  </span>
                  <span className="subtle">
                    {set.printings} printings · {set.scored} scored
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <ResultPager
          page={sets.page}
          pageCount={Math.max(1, Math.ceil(sets.total / sets.pageSize))}
          total={sets.total}
          pageSize={sets.pageSize}
          noun="sets"
          hrefFor={(page) => (page > 1 ? `/app/markets?setPage=${page}` : "/app/markets")}
        />
      </section>
    </>
  );
}
