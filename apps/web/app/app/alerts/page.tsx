import { createAlertAction, deleteAlertAction, toggleAlertAction } from "@/app/alert-actions";
import { EmptyState, LockedFeature } from "@/components/EmptyState";
import { loadAppAccess } from "@/lib/app-access";
import { getDb } from "@/lib/auth";
import { ALERT_RULE_TYPES, NOTIFICATION_CHANNELS, listAlertRules, withOrganizationContext } from "@isp/db";

export const dynamic = "force-dynamic";

export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId, userId, access } = await loadAppAccess();
  const query = await searchParams;
  if (!access.hasAlerts) {
    return (
      <LockedFeature
        title="Alerts"
        body="Alert rules are not entitled on this plan. The rule foundation exists; this UI stays locked."
      />
    );
  }
  const rules = await withOrganizationContext(getDb(), { organizationId, userId }, (scoped) =>
    listAlertRules(scoped, organizationId),
  );

  return (
    <>
      <h1>Alerts</h1>
      <p className="muted">Server-side validation applies. Channels: in-app, email, webhook.</p>
      {query.error ? <p className="form-error">Alert action was rejected.</p> : null}
      <form className="auth-form" action={createAlertAction}>
        <label>
          Rule type
          <select name="ruleType">
            {ALERT_RULE_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label>
          Channel
          <select name="channel" defaultValue="in_app">
            {NOTIFICATION_CHANNELS.map((channel) => (
              <option key={channel} value={channel}>
                {channel}
              </option>
            ))}
          </select>
        </label>
        <label>
          Threshold (opportunity)
          <input name="threshold" defaultValue="70" />
        </label>
        <label>
          Percent (price/usage)
          <input name="percent" defaultValue="80" />
        </label>
        <button type="submit">Create rule</button>
      </form>
      {rules.length === 0 ? (
        <EmptyState title="No alert rules" body="Create a threshold or event rule to watch opportunities and usage." />
      ) : (
        <ul>
          {rules.map((rule) => (
            <li key={rule.id}>
              {rule.ruleType} · {rule.channelPreference} · {rule.enabled ? "enabled" : "disabled"}
              <form action={toggleAlertAction}>
                <input type="hidden" name="ruleId" value={rule.id} />
                <input type="hidden" name="enabled" value={rule.enabled ? "false" : "true"} />
                <button className="link-button" type="submit">
                  {rule.enabled ? "Disable" : "Enable"}
                </button>
              </form>
              <form action={deleteAlertAction}>
                <input type="hidden" name="ruleId" value={rule.id} />
                <button className="link-button" type="submit">
                  Delete
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
