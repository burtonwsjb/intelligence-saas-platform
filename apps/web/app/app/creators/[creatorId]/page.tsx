import { Badge, StatusBadge } from "@/components/Badge";
import { CompactStat } from "@/components/CompactStat";
import { PreferenceButtons } from "@/components/CreatorPreferenceButtons";
import { EmptyState, LockedFeature } from "@/components/EmptyState";
import { MorePager } from "@/components/ResultPager";
import { ANALYTICS_LOCKED_BODY, loadAppAccess } from "@/lib/app-access";
import { getDb } from "@/lib/auth";
import { formatAge, formatDate, languageText, monogram } from "@/lib/display";
import {
  SENTIMENT_BASELINE_WEIGHT,
  getCreatorAuthorityProfile,
  getCreatorTrackRecord,
  listCreatorAccountLinks,
  listCreatorCallHistory,
  listTenantCreatorList,
  withOrganizationContext,
  type CreatorCallHistoryItem,
} from "@isp/db";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

const TRUST_TEXT: Record<string, { label: string; tone: "good" | "warn" | "info" }> = {
  trusted: { label: "Trusted track record", tone: "good" },
  reliable: { label: "Reliable track record", tone: "good" },
  developing: { label: "Developing track record", tone: "info" },
  low_confidence: { label: "Too few evaluated calls", tone: "info" },
  unreliable: { label: "Unreliable track record", tone: "warn" },
  excluded: { label: "Excluded by the operator", tone: "warn" },
};

const DIRECTION_TEXT: Record<string, string> = {
  bullish: "Said it would go up",
  bearish: "Said it would go down",
  neutral: "Neutral",
  hold: "Hold",
};

function compact(value: number | string | null | undefined): string {
  if (value == null) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

function outcomeBadge(call: CreatorCallHistoryItem) {
  if (!call.printingId) return <Badge>Card not identified</Badge>;
  if (call.outcomeStatus === "evaluated") {
    if (call.directionalCorrect === "correct") return <StatusBadge tone="good" label="Came true" />;
    if (call.directionalCorrect === "incorrect") return <StatusBadge tone="warn" label="Did not come true" />;
    return <Badge>Evaluated, no clear direction</Badge>;
  }
  if (call.outcomeStatus && call.outcomeStatus !== "pending") return <Badge>{call.outcomeStatus.replaceAll("_", " ")}</Badge>;
  return <Badge tone="info">Waiting for the market</Badge>;
}

export default async function CreatorDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ creatorId: string }>;
  searchParams: Promise<{ page?: string; error?: string }>;
}) {
  const { access, organizationId, userId } = await loadAppAccess();
  if (!access.hasCreatorAnalytics) {
    return <LockedFeature title="Creator" body="Creator analytics are not included in this workspace's plan." />;
  }
  if (!access.canViewAnalytics) {
    return <LockedFeature title="Creator" body={ANALYTICS_LOCKED_BODY} />;
  }
  const { creatorId } = await params;
  const query = await searchParams;
  const page = Math.max(1, Math.trunc(Number(query.page ?? 1)) || 1);
  const db = getDb();
  const profile = await getCreatorAuthorityProfile(db, creatorId);
  if (!profile.creator) notFound();
  const [record, history, accountLinks, list] = await Promise.all([
    getCreatorTrackRecord(db, creatorId),
    listCreatorCallHistory(db, creatorId, { page }),
    listCreatorAccountLinks(db, creatorId),
    withOrganizationContext(db, { organizationId, userId }, listTenantCreatorList),
  ]);
  const preference = list.find((row) => row.creatorId === creatorId)?.preference;
  const name = profile.creator.displayName ?? "Unnamed creator";
  const trust = TRUST_TEXT[profile.trustState] ?? { label: profile.trustState, tone: "info" as const };
  const headline = profile.headline;
  const discovery = profile.discovery[0];
  const weight = headline?.authorityWeight == null ? null : Number(headline.authorityWeight);
  const decided = record.correct + record.incorrect;
  const accuracy = decided > 0 ? Math.round((record.correct / decided) * 100) : null;
  const showAuthority = headline?.authorityScore != null && !["low_confidence", "excluded"].includes(profile.trustState);
  const selfHref = `/app/creators/${encodeURIComponent(creatorId)}`;

  return (
    <>
      <p className="subtle" style={{ margin: 0 }}>
        <Link href="/app/creators">← Creators</Link>
      </p>
      <header className="page-header">
        <div className="creator-head">
          <span className="avatar" aria-hidden="true">
            {monogram(name)}
          </span>
          <span className="item-main">
            <h1 style={{ margin: 0 }}>{name}</h1>
            <span className="subtle">
              {accountLinks.length
                ? accountLinks.map((link, index) => (
                    <span key={link.url}>
                      {index > 0 ? " · " : ""}
                      <a href={link.url} rel="noreferrer noopener" target="_blank">
                        {link.label}
                      </a>
                    </span>
                  ))
                : "No linked account"}
              {" · "}last seen {formatAge(profile.creator.lastSeenAt)}
            </span>
          </span>
        </div>
        <PreferenceButtons creatorId={creatorId} current={preference} returnTo={selfHref} />
      </header>
      {query.error ? <p className="notice">{query.error}</p> : null}
      <div className="badge-row">
        <StatusBadge tone={trust.tone} label={trust.label} />
        {preference === "follow" ? <Badge tone="good">You follow this creator</Badge> : null}
        {preference === "hide" ? <Badge tone="warn">Hidden from your views</Badge> : null}
        {discovery?.lastMonitorSuccessAt ? <Badge>New posts checked {formatAge(discovery.lastMonitorSuccessAt)}</Badge> : null}
      </div>

      <div className="stat-row">
        <CompactStat
          label="Calls that came true"
          value={accuracy == null ? "—" : `${accuracy}%`}
          note={decided > 0 ? `${record.correct} of ${decided} evaluated calls` : "No evaluated calls yet"}
        />
        <CompactStat label="Calls made" value={record.totalCalls} note={`${record.pending} waiting for the market`} />
        <CompactStat
          label="Authority"
          value={showAuthority ? Math.round(Number(headline!.authorityScore)) : "—"}
          note={showAuthority ? `from ${headline!.sampleSize} evaluated calls` : "Needs more evaluated calls"}
        />
        <CompactStat
          label="Weight in sentiment"
          value={weight == null ? "Baseline" : `${(weight / SENTIMENT_BASELINE_WEIGHT).toFixed(1)}×`}
          note="compared with an account with no track record"
        />
        <CompactStat label="Reach" value={compact(discovery?.reachSubscribers ?? discovery?.reachViews)} note="audience, not authority" />
      </div>
      <p className="subtle">
        Accuracy only counts calls the market has had time to answer. A creator needs enough evaluated calls before their
        track record moves their weight far from the baseline, so a few lucky calls do not make someone an authority.
      </p>

      <section className="panel" aria-labelledby="calls-heading">
        <h2 id="calls-heading">Calls</h2>
        {history.items.length === 0 ? (
          <EmptyState title="No calls yet" body="Calls appear when this creator says a card will go up or down." />
        ) : (
          <ul className="item-list">
            {history.items.map((call) => (
              <li key={call.id}>
                <span className="item-main">
                  <strong>
                    {call.printingId ? (
                      <Link href={`/app/cards/${encodeURIComponent(call.printingId)}?from=${encodeURIComponent(selfHref)}`}>
                        {call.cardName ?? "Card"}
                      </Link>
                    ) : (
                      "Card not identified"
                    )}
                  </strong>
                  <span className="subtle">
                    {DIRECTION_TEXT[call.direction] ?? call.direction.replaceAll("_", " ")} · {formatDate(call.publishedAt)}
                    {call.setName ? ` · ${call.setName}` : ""}
                    {call.languageCode ? ` · ${languageText(call.languageCode)}` : ""}
                    {call.horizonCode !== "unspecified" ? ` · within ${call.horizonCode.replaceAll("_", " ")}` : ""}
                    {call.returnPct != null ? ` · price moved ${(call.returnPct * 100).toFixed(1)}%` : ""}
                    {call.contentUrl ? (
                      <>
                        {" · "}
                        <a href={call.contentUrl} rel="noreferrer noopener" target="_blank">
                          source
                        </a>
                      </>
                    ) : null}
                  </span>
                </span>
                {outcomeBadge(call)}
              </li>
            ))}
          </ul>
        )}
        <MorePager
          page={history.page}
          hasMore={history.hasMore}
          hrefFor={(p) => (p > 1 ? `${selfHref}?page=${p}` : selfHref)}
        />
      </section>

      {profile.slices.length > 0 ? (
        <details className="panel">
          <summary>Track record by language and set</summary>
          <ul className="item-list">
            {profile.slices.slice(0, 20).map((slice) => (
              <li key={slice.id}>
                <span className="item-main">
                  <strong>
                    {slice.languageCode ? languageText(slice.languageCode) : "All languages"}
                    {slice.setKey ? ` · ${slice.setKey}` : ""}
                    {slice.horizonCode ? ` · ${slice.horizonCode.replaceAll("_", " ")}` : ""}
                  </strong>
                  <span className="subtle">
                    {slice.successes} of {slice.sampleSize} came true
                    {slice.wilsonLow != null ? ` · at least ${Math.round(Number(slice.wilsonLow) * 100)}% with 95% confidence` : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <p className="subtle">
        A creator&apos;s track record never becomes a buy or sell signal by itself. It decides how much their calls count in
        card sentiment and scores.
      </p>
    </>
  );
}
