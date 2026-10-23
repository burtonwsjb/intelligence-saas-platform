import { Badge, StatusBadge } from "@/components/Badge";
import { CardArt } from "@/components/CardArt";
import { ChartSentimentPanel } from "@/components/ChartSentiment";
import { EmptyState, LockedFeature } from "@/components/EmptyState";
import { PriceTrendChart } from "@/components/PriceTrendChart";
import { MorePager } from "@/components/ResultPager";
import { ScoreRing } from "@/components/ScoreRing";
import { SentimentVerdict } from "@/components/SentimentVerdict";
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
  plural,
  priceFreshness,
  providerText,
  quoteText,
  recommendationText,
  variantText,
} from "@/lib/display";
import {
  CARD_CALL_KINDS,
  EXPLORER_WINDOWS,
  comparableSoldSeries,
  explorerQueryToSearch,
  getCardSentiment,
  getChartSentiment,
  getPrintingWorkspace,
  listCardCreatorCalls,
  listCardEvidence,
  marketConfirmationState,
  parseExplorerQuery,
  publishedPredictionsForCustomer,
  scoredPriceBasis,
  windowChange,
  type CardCallKind,
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
  const callsParam = first(raw.calls);
  const callKind: CardCallKind = (CARD_CALL_KINDS as readonly string[]).includes(callsParam ?? "")
    ? (callsParam as CardCallKind)
    : "raw";
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
  const href = (overrides: { tab?: TabKey; window?: ExplorerWindow; page?: number; calls?: CardCallKind }) => {
    const next = new URLSearchParams();
    const t = overrides.tab ?? tab;
    if (t !== "overview") next.set("tab", t);
    const w = overrides.window ?? window;
    if (w !== "30d") next.set("window", w);
    if (overrides.page && overrides.page > 1) next.set("page", String(overrides.page));
    const c = overrides.calls ?? callKind;
    if (t === "creators" && c !== "raw") next.set("calls", c);
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
  const priceBasis = scoredPriceBasis(components);
  const marketNote =
    priceBasis == null
      ? "Whether the market price backs up the reading"
      : priceBasis.basis === "reference"
        ? `Measured against ${plural(priceBasis.points, "daily TCGplayer market price")}; 3 needed`
        : `Measured against ${plural(priceBasis.points, "recorded sale")}; 3 needed`;
  const hypeUnconfirmed = components.hype_unconfirmed === true;
  const headline = workspace.headline;
  const headlineSold = workspace.headlineKind === "sold";
  const series = comparableSoldSeries(headlineSold ? workspace.sold : workspace.referenceHistory, headline);
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
          <CardArt
            cardName={identity.cardName}
            setName={identity.setName}
            collectorNumber={identity.collectorNumber}
            imageUrl={identity.imageUrl}
          />
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
                  {headlineSold
                    ? `${quoteText("sold")} · ${conditionText(headline.condition)} · ungraded · ${headline.currency} · ${providerText(headline.sourceKey)}`
                    : `${quoteText("reference")} · ungraded · ${headline.currency} · ${providerText(headline.sourceKey)}`}
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
          <OverviewVerdict
            printingId={printingId}
            recommendation={score?.recommendation ?? null}
            uncalibrated={score?.uncalibrated === "true"}
            confirmation={confirmation}
            marketNote={marketNote}
            hiddenCreatorIds={await loadHiddenCreatorIds(organizationId, userId)}
            hrefs={{
              sentiment: href({ tab: "sentiment", page: 1 }),
              creators: href({ tab: "creators", page: 1 }),
              market: href({ tab: "market", page: 1 }),
            }}
          />
          <section className="panel" aria-labelledby="scores-heading">
            <h2 id="scores-heading">Score details</h2>
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
                    {hypeUnconfirmed ? " · social activity is ahead of the market price, so strong recommendations are blocked" : ""}
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
              <h2>{headlineSold || !headline ? "Sold price history" : "Market price history"}</h2>
            </div>
            {headline && !headlineSold ? (
              <PriceTrendChart
                points={series.points}
                currency={headline.currency}
                title={`TCGplayer market price, ungraded, ${headline.currency}`}
                caption={`Daily TCGplayer market price from ${providerText(headline.sourceKey)}. No sale in the last 30 days, so this is not a sold price.`}
              />
            ) : headline ? (
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
              <EmptyState
                title="No price yet"
                body="Prices appear once TCG Card Central reports a sale or a TCGplayer market price for this exact printing."
              />
            )}
          </section>
          <section className="panel">
            <h2>Current market</h2>
            <dl className="kv">
              <dt>Last valid sale</dt>
              <dd>
                {workspace.latestSold
                  ? `${formatMoney(workspace.latestSold.price, workspace.latestSold.currency)} · ${formatAge(workspace.latestSold.observedAt)} · ${providerText(workspace.latestSold.sourceKey)}`
                  : "—"}
              </dd>
              <dt>Lowest ask</dt>
              <dd>
                {workspace.listing
                  ? `${formatMoney(workspace.listing.lowPrice ?? workspace.listing.price, workspace.listing.currency)} · ${formatAge(workspace.listing.observedAt)}`
                  : "No listing data"}
              </dd>
              <dt>TCGplayer market</dt>
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
          kind={callKind}
          pageHref={(p) => href({ page: p })}
          kindHref={(calls) => href({ calls })}
          hiddenCreatorIds={await loadHiddenCreatorIds(organizationId, userId)}
        />
      ) : null}

      {tab === "evidence" ? <EvidencePanel printingId={printingId} page={page} pageHref={(p) => href({ page: p })} /> : null}
    </>
  );
}

async function OverviewVerdict({
  printingId,
  hiddenCreatorIds,
  ...props
}: Omit<Parameters<typeof SentimentVerdict>[0], "social" | "chart"> & { printingId: string; hiddenCreatorIds: string[] }) {
  const [social, charts] = await Promise.all([
    getCardSentiment(getDb(), printingId, "30d", { hiddenCreatorIds }),
    getChartSentiment(getDb(), [printingId]),
  ]);
  return <SentimentVerdict {...props} social={social} chart={charts.get(printingId)?.raw ?? null} />;
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
  const [summary, charts] = await Promise.all([
    getCardSentiment(getDb(), printingId, window, { hiddenCreatorIds }),
    getChartSentiment(getDb(), [printingId]),
  ]);
  return (
    <div className="panel-grid">
      <section className="panel">
        <div className="section-head" style={{ marginTop: 0 }}>
          <h2>Market sentiment</h2>
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
      <ChartSentimentPanel chart={charts.get(printingId)} />
    </div>
  );
}

const CALL_KIND_TEXT: Record<CardCallKind, string> = { raw: "Raw", graded: "Graded (slabs)" };

async function CreatorsPanel({
  printingId,
  page,
  kind,
  pageHref,
  kindHref,
  hiddenCreatorIds,
}: {
  printingId: string;
  page: number;
  kind: CardCallKind;
  pageHref: (page: number) => string;
  kindHref: (kind: CardCallKind) => string;
  hiddenCreatorIds: string[];
}) {
  const calls = await listCardCreatorCalls(getDb(), printingId, { page, hiddenCreatorIds, kind });
  return (
    <section className="panel">
      <div className="section-head" style={{ marginTop: 0 }}>
        <h2>Creator calls on this printing</h2>
        <nav className="segmented" aria-label="Raw or graded calls">
          {CARD_CALL_KINDS.map((k) => (
            <Link key={k} href={kindHref(k)} aria-current={k === kind ? "page" : undefined} scroll={false}>
              {CALL_KIND_TEXT[k]} ({calls.counts[k]})
            </Link>
          ))}
        </nav>
      </div>
      {calls.items.length === 0 ? (
        <EmptyState
          title={kind === "graded" ? "No graded calls" : "No raw calls"}
          body={
            kind === "graded"
              ? "No monitored creator has made a call about a graded copy (PSA, BGS, CGC, SGC) of this exact printing."
              : "No monitored creator has made a call about a raw copy of this exact printing."
          }
        />
      ) : (
        <ul className="item-list">
          {calls.items.map((call) => (
            <li key={call.id}>
              <span className="item-main">
                <Link href={`/app/creators/${encodeURIComponent(call.creatorId)}`}>{call.creatorName ?? "Unnamed creator"}</Link>
                {call.contentUrl ? (
                  <a href={call.contentUrl} target="_blank" rel="noopener noreferrer nofollow" className="text-link">
                    {call.contentTitle ?? "Open the original post"} ↗
                  </a>
                ) : null}
                <span className="subtle">
                  {formatDate(call.publishedAt)} · horizon {call.horizonCode.replaceAll("_", " ")}
                  {call.priceAtCall && call.priceCurrency ? ` · price at call ${formatMoney(call.priceAtCall, call.priceCurrency)}` : ""}
                </span>
              </span>
              <span className="badge-row">
                {call.grade ? <Badge>{call.grade}</Badge> : null}
                <Badge tone={call.direction === "bullish" ? "info" : call.direction === "bearish" ? "warn" : undefined}>
                  {call.direction.replaceAll("_", " ")}
                </Badge>
              </span>
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
