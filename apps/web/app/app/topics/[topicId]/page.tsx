import { removeTopicAction, setTopicStatusAction } from "@/app/topic-actions";
import { Badge, StatusBadge } from "@/components/Badge";
import { CallOutcomeBadge, callDirectionText, callHorizonText } from "@/components/CallOutcome";
import { EmptyState, LockedFeature } from "@/components/EmptyState";
import { SentimentDonut } from "@/components/SentimentSummary";
import { TopicTrendChart } from "@/components/TopicTrendChart";
import { ANALYTICS_LOCKED_BODY, loadAppAccess, loadHiddenCreatorIds } from "@/lib/app-access";
import { getDb } from "@/lib/auth";
import { formatAge, formatDate } from "@/lib/display";
import {
  SENTIMENT_BASELINE_WEIGHT,
  TOPIC_WINDOWS,
  getTenantTopic,
  getTopicCalls,
  getTopicSentiment,
  withOrganizationContext,
  type TopicWindow,
} from "@isp/db";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

const SENTIMENT_TEXT: Record<string, { label: string; tone?: "good" | "warn" | "info" }> = {
  positive: { label: "Bullish", tone: "info" },
  negative: { label: "Bearish", tone: "warn" },
  neutral: { label: "Neutral" },
  mixed: { label: "Mixed" },
  unknown: { label: "No clear sentiment" },
};

function formatPrice(value: string, currency: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: n >= 100 ? 0 : 2,
    }).format(n);
  } catch {
    return `${n.toLocaleString("en-US")} ${currency}`;
  }
}

const PLATFORM_TEXT: Record<string, string> = { youtube: "YouTube", reddit: "Reddit", web: "Web" };

export default async function TopicPage({
  params,
  searchParams,
}: {
  params: Promise<{ topicId: string }>;
  searchParams: Promise<{ window?: string }>;
}) {
  const { access, organizationId, userId } = await loadAppAccess();
  if (!access.canViewAnalytics) {
    return <LockedFeature title="Topic" body={ANALYTICS_LOCKED_BODY} />;
  }
  const { topicId } = await params;
  const query = await searchParams;
  const window: TopicWindow = (TOPIC_WINDOWS as readonly string[]).includes(query.window ?? "")
    ? (query.window as TopicWindow)
    : "30d";
  const db = getDb();
  const topic = await withOrganizationContext(db, { organizationId, userId }, (scoped) => getTenantTopic(scoped, topicId));
  if (!topic) notFound();
  const hiddenCreatorIds = await loadHiddenCreatorIds(organizationId, userId);
  const result = await getTopicSentiment(db, topic.query, window, { hiddenCreatorIds });
  const calls = result.asset ? await getTopicCalls(db, result.asset.id, { hiddenCreatorIds }) : null;
  const selfHref = `/app/topics/${encodeURIComponent(topic.id)}`;

  return (
    <>
      <p className="subtle" style={{ margin: 0 }}>
        <Link href="/app/topics">← Topics</Link>
      </p>
      <header className="page-header">
        <div>
          <p className="eyebrow">Topic</p>
          <h1>{topic.query}</h1>
          <p className="muted">
            {result.asset
              ? `Posts that mention ${[result.asset.displayName, ...result.asset.aliases.filter((alias) => alias.length <= 4).map((alias) => alias.toUpperCase())].join(" or ")}`
              : `Posts that mention ${result.tokens.map((token) => `“${token}”`).join(" and ")}`}{" "}
            on the sources the platform monitors. {topic.lastSearchedAt ? `Last searched ${formatAge(topic.lastSearchedAt)}.` : "Not searched yet; the next collection run picks it up."}
          </p>
        </div>
        <div className="badge-row" style={{ alignItems: "center", gap: "var(--space-4)" }}>
          {topic.status === "paused" ? <Badge tone="warn">Paused</Badge> : null}
          <form action={setTopicStatusAction}>
            <input type="hidden" name="topicId" value={topic.id} />
            <input type="hidden" name="status" value={topic.status === "paused" ? "active" : "paused"} />
            <input type="hidden" name="returnTo" value="detail" />
            <button className="link-button text-link" type="submit">
              {topic.status === "paused" ? "Resume" : "Pause searching"}
            </button>
          </form>
          <form action={removeTopicAction}>
            <input type="hidden" name="topicId" value={topic.id} />
            <button className="link-button text-link" type="submit">
              Stop tracking
            </button>
          </form>
        </div>
      </header>

      <section className="panel">
        <div className="section-head" style={{ marginTop: 0 }}>
          <h2>Sentiment</h2>
          <nav className="segmented" aria-label="Sentiment window">
            {TOPIC_WINDOWS.map((w) => (
              <Link key={w} href={`${selfHref}?window=${w}`} aria-current={w === window ? "page" : undefined} scroll={false}>
                {w}
              </Link>
            ))}
          </nav>
        </div>
        <SentimentDonut summary={result.summary} scope="content that mentions this topic" />
        {result.truncated ? (
          <p className="notice info">Only the newest 2,000 posts in this window are counted.</p>
        ) : null}
      </section>

      <section className="panel">
        <h2>Over time</h2>
        <TopicTrendChart buckets={result.buckets} bucketDays={result.bucketDays} />
      </section>

      {result.asset && calls ? (
        <section className="panel" aria-labelledby="calls-heading">
          <h2 id="calls-heading">Calls about {result.asset.displayName}</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            {calls.total === 0
              ? "No calls yet. A call is a post that says the price will go up or down."
              : `${calls.total} ${calls.total === 1 ? "call" : "calls"} · ${calls.evaluated} judged so far` +
                (calls.evaluated > 0
                  ? ` · ${Math.round((calls.correct / calls.evaluated) * 100)}% came true`
                  : "") +
                (calls.pending > 0 ? ` · ${calls.pending} waiting for the market` : "")}
          </p>
          <p className="subtle">
            {calls.latestPrice
              ? `Latest price ${formatPrice(calls.latestPrice.price, calls.latestPrice.currency)}, ${formatAge(calls.latestPrice.observedAt)}. `
              : "No prices collected for this yet, so its calls wait until prices arrive. "}
            Each call is judged on the price at the time of the post against the price when its deadline passes. Those
            results set how much each creator counts here.
          </p>
          {calls.calls.length > 0 ? (
            <ul className="item-list">
              {calls.calls.map((call) => (
                <li key={call.callId}>
                  <span className="item-main">
                    <strong>
                      <Link href={`/app/creators/${encodeURIComponent(call.creatorId)}`}>
                        {call.creatorName ?? "Unnamed creator"}
                      </Link>
                    </strong>
                    <span className="subtle">
                      {callDirectionText(call.direction)} · {formatDate(call.publishedAt)} · {callHorizonText(call.horizonCode)}
                      {call.priceAtCall ? ` · at ${formatPrice(call.priceAtCall, call.priceCurrency ?? "USD")}` : ""}
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
                  <CallOutcomeBadge
                    identified
                    outcomeStatus={call.outcomeStatus}
                    directionalCorrect={call.directionalCorrect}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <section className="panel" aria-labelledby="voices-heading">
        <h2 id="voices-heading">Who is talking</h2>
        {result.voices.length === 0 ? (
          <EmptyState title="Nobody yet" body="Accounts appear here once posts about this topic are collected." />
        ) : (
          <ul className="item-list">
            {result.voices.map((voice) => (
              <li key={voice.accountId}>
                <span className="item-main">
                  <strong>
                    {voice.creatorId ? (
                      <Link href={`/app/creators/${encodeURIComponent(voice.creatorId)}`}>{voice.name}</Link>
                    ) : (
                      voice.name
                    )}
                  </strong>
                  <span className="subtle">
                    {PLATFORM_TEXT[voice.sourceType] ?? voice.sourceType} · {voice.posts}{" "}
                    {voice.posts === 1 ? "post" : "posts"} ·{" "}
                    {voice.rated
                      ? `counts ${(voice.weight / SENTIMENT_BASELINE_WEIGHT).toFixed(1)}× from their track record`
                      : "no track record yet"}
                  </span>
                </span>
                <Badge tone={SENTIMENT_TEXT[voice.leaning]?.tone}>{`Leans ${SENTIMENT_TEXT[voice.leaning]?.label.toLowerCase()}`}</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="posts-heading">
        <h2 id="posts-heading">Latest posts</h2>
        {result.recent.length === 0 ? (
          <EmptyState title="No posts yet" body="Posts appear after the topic has been searched." />
        ) : (
          <ul className="item-list">
            {result.recent.map((post) => (
              <li key={post.contentId}>
                <span className="item-main">
                  <a href={post.url} rel="noreferrer noopener" target="_blank">
                    {post.title ?? "Untitled post"}
                  </a>
                  <span className="subtle">
                    {post.accountName ?? "Unnamed account"} · {PLATFORM_TEXT[post.sourceType] ?? post.sourceType} ·{" "}
                    {formatDate(post.publishedAt)}
                  </span>
                </span>
                {post.sentiment === "unknown" ? (
                  <Badge>{SENTIMENT_TEXT.unknown!.label}</Badge>
                ) : (
                  <StatusBadge
                    tone={post.sentiment === "negative" ? "warn" : "info"}
                    label={SENTIMENT_TEXT[post.sentiment]!.label}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="notice info">
        Sentiment here is read from post titles and descriptions with rule-based buy, sell, up and down language. It does
        not understand sarcasm and works best in English. Coverage is YouTube, Reddit and, when the operator turns it on, Google web search.
        {result.asset ? "" : " Calls are scored for cards and for tracked assets such as Bitcoin, Ethereum and Solana."}
      </p>
    </>
  );
}
