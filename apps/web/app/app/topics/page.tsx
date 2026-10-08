import { addTopicAction } from "@/app/topic-actions";
import { Badge } from "@/components/Badge";
import { EmptyState, LockedFeature } from "@/components/EmptyState";
import { ANALYTICS_LOCKED_BODY, loadAppAccess, loadHiddenCreatorIds } from "@/lib/app-access";
import { getDb } from "@/lib/auth";
import { formatAge } from "@/lib/display";
import {
  SENTIMENT_LABEL_TEXT,
  getTopicSentiment,
  listSealedProducts,
  listTenantTopics,
  withOrganizationContext,
} from "@isp/db";
import Link from "next/link";

export const dynamic = "force-dynamic";

const EXAMPLES = ["Ascended Heroes", "Charizard ex", "Pokemon sealed", "Bitcoin"];

export default async function TopicsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { access, organizationId, userId } = await loadAppAccess();
  if (!access.canViewAnalytics) {
    return <LockedFeature title="Topics" body={ANALYTICS_LOCKED_BODY} />;
  }
  const query = await searchParams;
  const db = getDb();
  const [topics, hiddenCreatorIds, sealed] = await Promise.all([
    withOrganizationContext(db, { organizationId, userId }, listTenantTopics),
    loadHiddenCreatorIds(organizationId, userId),
    listSealedProducts(db),
  ]);
  const tracked = new Set(topics.map((topic) => topic.query.toLowerCase()));
  const sealedBySet = new Map<string, typeof sealed>();
  for (const product of sealed) {
    sealedBySet.set(product.setName, [...(sealedBySet.get(product.setName) ?? []), product]);
  }
  const summaries = await Promise.all(
    topics.map((topic) => getTopicSentiment(db, topic.query, "30d", { hiddenCreatorIds }).then((result) => result.summary)),
  );

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Topics</p>
          <h1>What you are tracking</h1>
          <p className="muted">
            Add anything you want to follow: a set, a card, a product, or something outside cards entirely. The platform
            searches YouTube and Reddit for it, finds the people talking about it, and keeps listening.
          </p>
        </div>
      </header>
      {query.error ? <p className="notice">{query.error}</p> : null}
      <section className="panel" aria-labelledby="add-topic-heading">
        <h2 id="add-topic-heading">Track a topic</h2>
        <form className="filter-form" action={addTopicAction} style={{ margin: 0 }}>
          <label className="field" style={{ flex: "3 1 18rem" }}>
            Topic
            <input name="query" type="text" required minLength={3} maxLength={120} placeholder="e.g. Ascended Heroes" />
          </label>
          <button type="submit">Track</button>
        </form>
        <p className="subtle">Examples: {EXAMPLES.join(", ")}. New topics are searched on the next collection run.</p>
        {sealedBySet.size > 0 ? (
          <details>
            <summary>Sealed products</summary>
            <p className="subtle">
              Track a sealed product to see what people say about it and how their calls on its price turn out.
            </p>
            <ul className="item-list">
              {[...sealedBySet].map(([setName, products]) => (
                <li key={setName}>
                  <span className="item-main">
                    <strong>{setName}</strong>
                  </span>
                  <span className="badge-row" style={{ gap: "var(--space-4)" }}>
                    {products.map((product) => {
                      const label = product.displayName.slice(setName.length).trim() || product.displayName;
                      return tracked.has(product.displayName.toLowerCase()) ? (
                        <span key={product.id} className="subtle">
                          {label} · tracking
                        </span>
                      ) : (
                        <form key={product.id} action={addTopicAction}>
                          <input type="hidden" name="query" value={product.displayName} />
                          <button className="link-button text-link" type="submit" aria-label={`Track ${product.displayName}`}>
                            {label}
                          </button>
                        </form>
                      );
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>
      {topics.length === 0 ? (
        <EmptyState title="No topics yet" body="Track a topic above to see what people are saying about it." />
      ) : (
        <ul className="panel-grid" style={{ listStyle: "none", padding: 0, margin: "var(--space-4) 0 0" }}>
          {topics.map((topic, index) => {
            const summary = summaries[index]!;
            return (
              <li key={topic.id} className="panel creator-tile" style={{ margin: 0 }}>
                <h3 className="card-title">
                  <Link href={`/app/topics/${encodeURIComponent(topic.id)}`}>{topic.query}</Link>
                </h3>
                <p style={{ margin: 0, fontWeight: 620 }}>{SENTIMENT_LABEL_TEXT[summary.label]}</p>
                <span className="subtle">
                  {summary.contentItems} {summary.contentItems === 1 ? "post" : "posts"} from {summary.uniqueAccounts}{" "}
                  {summary.uniqueAccounts === 1 ? "account" : "accounts"} in the last 30 days
                </span>
                <div className="badge-row">
                  {topic.status === "paused" ? <Badge tone="warn">Paused</Badge> : null}
                  <Badge>{topic.lastSearchedAt ? `searched ${formatAge(topic.lastSearchedAt)}` : "not searched yet"}</Badge>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
