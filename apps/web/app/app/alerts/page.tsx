import { createAlertAction, deleteAlertAction, toggleAlertAction } from "@/app/alert-actions";
import { Badge } from "@/components/Badge";
import { EmptyState, LockedFeature } from "@/components/EmptyState";
import { loadAppAccess } from "@/lib/app-access";
import { getDb } from "@/lib/auth";
import { ALERT_RULE_TYPES, NOTIFICATION_CHANNELS, listAlertRules, withOrganizationContext } from "@isp/db";

export const dynamic = "force-dynamic";

const RULE_TEXT: Record<string, string> = {
  opportunity_score_threshold: "Opportunity score crosses a threshold",
  recommendation_change: "A recommendation changes",
  price_move: "Price moves by a percentage",
  creator_call: "A creator makes a call",
  creator_consensus: "Creators reach consensus",
  prediction_created: "A forecast is published",
  usage_threshold: "API usage reaches a percentage of quota",
  webhook_failure: "A webhook delivery fails",
};

const CHANNEL_TEXT: Record<string, string> = { in_app: "In the app", email: "Email", webhook: "Webhook" };

function ruleDetail(config: Record<string, unknown>): string | null {
  if (typeof config.threshold === "number") return `threshold ${config.threshold}`;
  if (typeof config.percent === "number") return `${config.percent}%`;
  return null;
}

export default async function WatchlistPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId, userId, access } = await loadAppAccess();
  const query = await searchParams;
  if (!access.hasAlerts) {
    return (
      <LockedFeature
        title="Watchlist"
        body="Watch rules and alerts are not included in this workspace’s plan."
      />
    );
  }
  const rules = await withOrganizationContext(getDb(), { organizationId, userId }, (scoped) =>
    listAlertRules(scoped, organizationId),
  );

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Watchlist</p>
          <h1>What you are watching</h1>
          <p className="muted">Rules notify you when something you care about changes. They apply across the cards you can see.</p>
        </div>
      </header>
      {query.error ? <p className="notice">That rule could not be saved. Check the values and try again.</p> : null}

      <section className="panel" aria-labelledby="rules-heading">
        <h2 id="rules-heading">Your rules</h2>
        {rules.length === 0 ? (
          <EmptyState title="No watch rules yet" body="Add a rule below to be told when scores, prices or creator calls change." />
        ) : (
          <ul className="item-list">
            {rules.map((rule) => {
              const detail = ruleDetail(rule.config);
              return (
                <li key={rule.id}>
                  <span className="item-main">
                    <strong>{RULE_TEXT[rule.ruleType] ?? rule.ruleType}</strong>
                    <span className="subtle">
                      {CHANNEL_TEXT[rule.channelPreference] ?? rule.channelPreference}
                      {detail ? ` · ${detail}` : ""}
                    </span>
                  </span>
                  <span className="badge-row" style={{ alignItems: "center" }}>
                    <Badge tone={rule.enabled ? "good" : "info"}>{rule.enabled ? "On" : "Paused"}</Badge>
                    <form action={toggleAlertAction}>
                      <input type="hidden" name="ruleId" value={rule.id} />
                      <input type="hidden" name="enabled" value={rule.enabled ? "false" : "true"} />
                      <button className="link-button text-link" type="submit">
                        {rule.enabled ? "Pause" : "Resume"}
                      </button>
                    </form>
                    <form action={deleteAlertAction}>
                      <input type="hidden" name="ruleId" value={rule.id} />
                      <button className="link-button text-link" type="submit">
                        Delete
                      </button>
                    </form>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="new-rule-heading">
        <h2 id="new-rule-heading">Add a rule</h2>
        <form className="filter-form" action={createAlertAction} style={{ margin: 0 }}>
          <label className="field" style={{ flex: "2 1 16rem" }}>
            Tell me when
            <select name="ruleType">
              {ALERT_RULE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {RULE_TEXT[type] ?? type}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Notify by
            <select name="channel" defaultValue="in_app">
              {NOTIFICATION_CHANNELS.map((channel) => (
                <option key={channel} value={channel}>
                  {CHANNEL_TEXT[channel] ?? channel}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Score threshold
            <input name="threshold" type="number" min={0} max={100} defaultValue="70" />
          </label>
          <label className="field">
            Percent
            <input name="percent" type="number" min={0} max={100} defaultValue="80" />
          </label>
          <button type="submit">Add rule</button>
        </form>
        <p className="subtle">
          Score threshold applies to opportunity rules. Percent applies to price-move and usage rules. Other rules ignore both.
        </p>
      </section>
    </>
  );
}
