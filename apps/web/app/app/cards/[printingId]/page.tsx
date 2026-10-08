import { Badge, StatusBadge } from "@/components/Badge";
import { CardArt } from "@/components/CardArt";
import { EmptyState, LockedFeature } from "@/components/EmptyState";
import { PriceTrendChart } from "@/components/PriceTrendChart";
import { MorePager } from "@/components/ResultPager";
import { ScoreRing } from "@/components/ScoreRing";
import { SentimentDonut } from "@/components/SentimentSummary";
import { Tabs } from "@/components/Tabs";
import { TechnicalDetails, explanationText } from "@/components/TechnicalDetails";
import { ANALYTICS_LOCKED_BODY, loadAppAccess, loadHiddenCreatorIds } from "@/lib/app-access";
import { getDb } from "@/lib/auth";
import {
  CONFIRMATION_TEXT,
  conditionText,
  dataQualityText,
  formatAge,
  formatChange,
  formatDate,
  languageText,
  priceFreshness,
  recommendationText,
  variantText,
} from "@/lib/display";
import {
  EXPLORER_WINDOWS,
  comparableSoldSeries,
  explorerQueryToSearch,
  getCardSentiment,
  getPrintingWorkspace,
  listCardCreatorCalls,
  listCardEvidence,
  marketConfirmationState,
  parseExplorerQuery,
  publishedPredictionsForCustomer,
  windowChange,
  type ExplorerWindow,
} from "@isp/db";
import { formatMoney } from "@isp/shared";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "market", label: "Market" },
  { key: "sentiment", label: "Sentiment" },
  { key: "creators", label: "Creators" },
  { key: "evidence", label: "Evidence" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function asBool(value: unknown): boolean | null {
  return value === true ? true : value === false ? false : null;
}

export default async function CardDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ printingId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { access, organizationId, userId } = await loadAppAccess();
  if (!access.canViewAnalytics) {
    return <LockedFeature title="Card" body={ANALYTICS_LOCKED_BODY} />;
  }
  const { printingId: rawId } = await params;
  const printingId = decodeURIComponent(rawId);
  const raw = await searchParams;
  const tabParam = first(raw.tab);
  const tab: TabKey = TABS.some((item) => item.key === tabParam) ? (tabParam as TabKey) : "overview";
  const windowParam = first(raw.window);
  const window: ExplorerWindow = (EXPLORER_WINDOWS as readonly string[]).includes(windowParam ?? "")
    ? (windowParam as ExplorerWindow)
    : "30d";
  const page = Math.max(1, Math.min(500, Math.trunc(Number(first(raw.page) ?? 1)) || 1));
  // The list state travels as an opaque param; re-parse it so only valid explorer state is echoed back.
  const fromRaw = first(raw.from);
  const backSearch = fromRaw?.startsWith("?")
    ? explorerQueryToSearch(parseExplorerQuery(Object.fromEntries(new URLSearchParams(fromRaw))))
    : "";
  const backHref = `/app/cards${backSearch}`;

  const workspace = await getPrintingWorkspace(getDb(), printingId);
  if (!workspace) {
    notFound();
  }
  const { identity, score } = workspace;
  const base = `/app/cards/${encodeURIComponent(printingId)}`;
  const href = (overrides: { tab?: TabKey; window?: ExplorerWindow; page?: number }) => {
    const next = new URLSearchParams();
    const t = overrides.tab ?? tab;
    if (t !== "overview") next.set("tab", t);
    const w = overrides.window ?? window;
    if (w !== "30d") next.set("window", w);
    if (overrides.page && overrides.page > 1) next.set("page", String(overrides.page));
    if (backSearch) next.set("from", backSearch);
    const text = next.toString();
    return text ? `${base}?${text}` : base;
  };

  const components = (score?.components ?? {}) as Record<string, unknown>;
  const scoreView = score
    ? {
        dataQuality: score.dataQuality,
        marketConfirmed: asBool(components.market_confirmed),
      }
    : null;
  const confirmation = CONFIRMATION_TEXT[marketConfirmationState(scoreView)];
  const hypeUnconfirmed = components.hype_unconfirmed === true;
  const headline = workspace.latestSold;
  const series = comparableSoldSeries(workspace.sold, headline);
  const freshness = priceFreshness(headline?.observedAt);
  const windowFrom = Date.now() - { "7d": 7, "30d": 30, "90d": 90 }[window] * 86_400_000;
  const windowPoints = series.points.filter((point) => point.observedAt.getTime() > windowFrom);
  const change = formatChange(windowChange(windowPoints));
  const explanations = Array.isArray(score?.explanations) ? score.explanations : [];
  const drivers = explanations.filter(
    (item) => !(item && typeof item === "object" && "code" in item && (item as { code: string }).code === "recommendation"),
  );

  return (
    <>
      <p style={{ margin: "0 0 var(--space-3)" }}>
        <Link className="text-link" href={backHref}>
          ← Back to cards
        </Link>
      </p>
      <header className="detail-header">
        <div className="card-art">
          <CardArt cardName={identity.cardName} setName={identity.setName} collectorNumber={identity.collectorNumber} />
        </div>
        <div>
          <p className="eyebrow">
            {identity.setName} · #{identity.collectorNumber}
          </p>
          <h1>{identity.cardName}</h1>
          <div className="badge-row">
            <Badge>{languageText(identity.languageCode)}</Badge>
            <Badge>{variantText(identity.variantKey)}</Badge>
            {identity.rarity ? <Badge>{identity.rarity}</Badge> : null}
            {identity.finish ? <Badge>{identity.finish}</Badge> : null}
          </div>
          <div className="detail-price">
            {headline ? (
              <>
                <span className="amount">{formatMoney(headline.price, headline.currency)}</span>
                <span className="subtle">
                  Last sold · {conditionText(headline.condition)} · ungraded · {headline.currency} · {headline.sourceKey}
                </span>
                {change ? (
                  <span className={`change ${change.direction}`}>
                    {change.text} over {window}
                  </span>
                ) : null}
              </>
            ) : (
              <span className="muted">No valid sale on record for this exact printing.</span>
            )}
          </div>
          <div className="badge-row" style={{ marginTop: "var(--space-2)" }}>
            <StatusBadge tone={freshness.tone} label={freshness.label} />
            <StatusBadge tone={confirmation.tone} label={confirmation.label} />
          </div>
        </div>
      </header>

      <Tabs label="Card sections" active={tab} tabs={TABS.map((item) => ({ ...item, href: href({ tab: item.key, page: 1 }) }))} />

      {tab === "overview" ? (
        <>
          <section className="panel" aria-labelledby="scores-heading">
            <h2 id="scores-heading" className="visually-hidden">
              Scores
            </h2>
            {score ? (
              <>
                <div className="ring-row">
                  <ScoreRing kind="opportunity" value={Number(score.opportunityScore)} />
                  <ScoreRing kind="risk" value={Number(score.riskScore)} />
                  <ScoreRing kind="confidence" value={Number(score.confidenceScore)} />
                  <ScoreRing kind="liquidity" value={Number(score.liquidityScore)} />
                </div>
                <dl className="kv" style={{ marginTop: "var(--space-5)" }}>
                  <dt>Recommendation</dt>
                  <dd>
                    <strong>{recommendationText(score.recommendation)}</strong>
                    {score.uncalibrated === "true" ? " · uncalibrated model, not investment advice" : ""}
                  </dd>
                  <dt>Market confirmation</dt>
                  <dd>
                    {confirmation.label}
                    {hypeUnconfirmed ? " · social activity is ahead of sales, so strong recommendations are blocked" : ""}
                  </dd>
                  <dt>Data quality</dt>
                  <dd>{dataQualityText(score.dataQuality).label}</dd>
                  <dt>Scored</dt>
                  <dd>
                    {formatDate(score.asOf)} ({formatAge(score.asOf)}) · version {score.scoreVersion}
                  </dd>
                </dl>
              </>
            ) : (
              <EmptyState
                title="Not scored yet"
                body="This printing has no score snapshot. Identity and any market data are still shown; a score appears once the scoring job has enough evidence."
              />
            )}
          </section>
          {score ? (
            <section className="panel">
              <h2>What is driving it</h2>
              {drivers.length === 0 ? (
                <p className="muted">The score did not record any drivers.</p>
              ) : (
                <ul className="drivers">
                  {drivers.map((item, index) => (
                    <li key={index}>{explanationText(item)}</li>
                  ))}
                </ul>
              )}
              <TechnicalDetails title="Score components (technical)">
                <pre className="json-block">{JSON.stringify(components, null, 2)}</pre>
              </TechnicalDetails>
            </section>
          ) : null}
          <ForecastPanel
            workspace={workspace}
            entitled={access.hasPredictionsEntitlement}
            flagEnabled={access.predictionsCustomerVisible}
          />
        </>
      ) : null}

      {tab === "market" ? (
        <>
          <section className="panel">
            <div className="section-head" style={{ marginTop: 0 }}>
              <h2>Sold price history</h2>
            </div>
            {headline ? (
              <PriceTrendChart
                points={series.points}
                currency={headline.currency}
                title={`Sold prices, ${conditionText(headline.condition)}, ungraded, ${headline.currency}`}
                caption={`Last valid sales only: ${conditionText(headline.condition)}, ungraded, in ${headline.currency}. ${
                  series.outliers > 0 ? `${series.outliers} outlier sale${series.outliers === 1 ? "" : "s"} kept as evidence but not plotted. ` : ""
                }${
                  series.otherGroups > 0
                    ? `${series.otherGroups} sale${series.otherGroups === 1 ? "" : "s"} in another condition, grade or currency not mixed in. `
                    : ""
                }Asks and reference prices are shown separately below and never joined to this line.`}
              />
            ) : (
              <EmptyState title="No sales on record" body="Sold history appears once a market source reports a valid sale for this exact printing." />
            )}
          </section>
          <section className="panel">
            <h2>Current market</h2>
            <dl className="kv">
              <dt>Last valid sale</dt>
              <dd>
                {headline
                  ? `${formatMoney(headline.price, headline.currency)} · ${formatAge(headline.observedAt)} · ${headline.sourceKey}`
                  : "—"}
              </dd>
              <dt>Lowest ask</dt>
              <dd>
                {workspace.listing
                  ? `${formatMoney(workspace.listing.lowPrice ?? workspace.listing.price, workspace.listing.currency)} · ${formatAge(workspace.listing.observedAt)}`
                  : "No listing data"}
              </dd>
              <dt>Reference price</dt>
              <dd>
                {workspace.reference
                  ? `${formatMoney(workspace.reference.price, workspace.reference.currency)} · ${formatAge(workspace.reference.observedAt)} · not an ask or a sale`
                  : "No reference price"}
              </dd>
              <dt>Ask vs last sale</dt>
              <dd>
                {workspace.spread?.spread_abs == null || workspace.spread.currency == null
                  ? "Not comparable"
                  : `${formatMoney(workspace.spread.spread_abs, workspace.spread.currency)}${workspace.spread.spread_abs < 0 ? " (ask below last sale)" : ""}`}
              </dd>
              <dt>Listings · sellers</dt>
              <dd>
                {workspace.listing?.listingCount ?? "—"} · {workspace.listing?.sellerCount ?? "—"}
              </dd>
              {workspace.features ? (
                <>
                  <dt>Feature sample</dt>
                  <dd>
                    {workspace.features.sampleSize} observations · {dataQualityText(workspace.features.dataQuality).label} ·{" "}
                    {formatDate(workspace.features.asOf)}
                  </dd>
                </>
              ) : null}
            </dl>
            {workspace.latestObservedSold?.outlierFlag ? (
              <p className="notice">
                The most recent sale ({formatMoney(workspace.latestObservedSold.price, workspace.latestObservedSold.currency)}) is
                flagged as an outlier and is not used as the headline price.
              </p>
            ) : null}
            {workspace.features ? (
              <TechnicalDetails title="Market features (technical)">
                <pre className="json-block">{JSON.stringify(workspace.features.features, null, 2)}</pre>
              </TechnicalDetails>
            ) : null}
          </section>
        </>
      ) : null}

      {tab === "sentiment" ? (
        <SentimentPanel
          printingId={printingId}
          window={window}
          windowHref={(w) => href({ window: w })}
          hiddenCreatorIds={await loadHiddenCreatorIds(organizationId, userId)}
        />
      ) : null}

      {tab === "creators" ? (
        <CreatorsPanel
          printingId={printingId}
          page={page}
          pageHref={(p) => href({ page: p })}
          hiddenCreatorIds={await loadHiddenCreatorIds(organizationId, userId)}
        />
      ) : null}

      {tab === "evidence" ? <EvidencePanel printingId={printingId} page={page} pageHref={(p) => href({ page: p })} /> : null}
    </>
  );
}

async function SentimentPanel({
  printingId,
  window,
  windowHref,
  hiddenCreatorIds,
}: {
  printingId: string;
  window: ExplorerWindow;
  windowHref: (window: ExplorerWindow) => string;
  hiddenCreatorIds: string[];
}) {
  const summary = await getCardSentiment(getDb(), printingId, window, { hiddenCreatorIds });
  return (
    <section className="panel">
      <div className="section-head" style={{ marginTop: 0 }}>
        <h2>Social sentiment</h2>
        <nav className="segmented" aria-label="Sentiment window">
          {EXPLORER_WINDOWS.map((w) => (
            <Link key={w} href={windowHref(w)} aria-current={w === window ? "page" : undefined} scroll={false}>
              {w}
            </Link>
          ))}
        </nav>
      </div>
      <SentimentDonut summary={summary} />
      <p className="notice info">
        Sentiment describes what people are saying. It is not market confirmation: check the Market tab for whether sales
        support it. Coverage is limited to the sources currently monitored, not every conversation online.
      </p>
    </section>
  );
}

async function CreatorsPanel({
  printingId,
  page,
  pageHref,
  hiddenCreatorIds,
}: {
  printingId: string;
  page: number;
  pageHref: (page: number) => string;
  hiddenCreatorIds: string[];
}) {
  const calls = await listCardCreatorCalls(getDb(), printingId, { page, hiddenCreatorIds });
  return (
    <section className="panel">
      <h2>Creator calls on this printing</h2>
      {calls.items.length === 0 ? (
        <EmptyState title="No creator calls" body="No monitored creator has made a call resolved to this exact printing." />
      ) : (
        <ul className="item-list">
          {calls.items.map((call) => (
            <li key={call.id}>
              <span className="item-main">
                <Link href={`/app/creators/${encodeURIComponent(call.creatorId)}`}>{call.creatorName ?? "Unnamed creator"}</Link>
                <span className="subtle">
                  {formatDate(call.publishedAt)} · horizon {call.horizonCode.replaceAll("_", " ")}
                  {call.priceAtCall && call.priceCurrency ? ` · price at call ${formatMoney(call.priceAtCall, call.priceCurrency)}` : ""}
                </span>
              </span>
              <Badge tone={call.direction === "bullish" ? "info" : call.direction === "bearish" ? "warn" : undefined}>
                {call.direction.replaceAll("_", " ")}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <MorePager page={calls.page} hasMore={calls.hasMore} hrefFor={pageHref} />
      <p className="subtle">A call is a claim, not an outcome. Open a creator to see how their evaluated calls turned out.</p>
    </section>
  );
}

async function EvidencePanel({ printingId, page, pageHref }: { printingId: string; page: number; pageHref: (page: number) => string }) {
  const evidence = await listCardEvidence(getDb(), printingId, { page });
  return (
    <section className="panel">
      <h2>Source evidence</h2>
      <p className="subtle">Posts and videos whose mentions were resolved to this exact printing, newest first.</p>
      {evidence.items.length === 0 ? (
        <EmptyState title="No resolved sources" body="No monitored content has been resolved to this exact printing yet." />
      ) : (
        <ul className="item-list">
          {evidence.items.map((item) => (
            <li key={item.contentId}>
              <span className="item-main">
                <a href={item.canonicalUrl} target="_blank" rel="noopener noreferrer nofollow">
                  {item.title ?? "Untitled source"}
                </a>
                <span className="subtle">
                  {item.sourceType} · {item.accountName ?? "unknown account"} · {formatDate(item.publishedAt)}
                </span>
              </span>
              <Badge>{item.sentiment === "unknown" ? "unclassified" : item.sentiment}</Badge>
            </li>
          ))}
        </ul>
      )}
      <MorePager page={evidence.page} hasMore={evidence.hasMore} hrefFor={pageHref} />
    </section>
  );
}

function ForecastPanel({
  workspace,
  entitled,
  flagEnabled,
}: {
  workspace: NonNullable<Awaited<ReturnType<typeof getPrintingWorkspace>>>;
  entitled: boolean;
  flagEnabled: boolean;
}) {
  // Forecasts stay behind the existing entitlement and publication gates.
  if (!entitled || !flagEnabled) return null;
  const visible = publishedPredictionsForCustomer(workspace.predictions, { entitled, flagEnabled });
  const currency = workspace.latestSold?.currency ?? workspace.reference?.currency ?? null;
  return (
    <section className="panel">
      <h2>Published forecasts</h2>
      {visible.length === 0 ? (
        <p className="muted">No published forecasts for this printing.</p>
      ) : (
        <ul className="item-list">
          {visible.map((row) => (
            <li key={row.id}>
              <span className="item-main">
                <strong>{row.horizon}</strong>
                <span className="subtle">
                  issued {formatDate(row.issuedAt)}
                  {row.priceAtIssue && currency ? ` · price at issue ${formatMoney(row.priceAtIssue, currency)}` : ""}
                </span>
              </span>
              <span className="subtle">
                expected {row.expectedReturn == null ? "—" : `${(Number(row.expectedReturn) * 100).toFixed(1)}%`} · confidence{" "}
                {row.confidence == null ? "—" : Number(row.confidence).toFixed(2)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
