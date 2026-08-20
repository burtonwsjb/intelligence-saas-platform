import { BETA_COHORTS, FEATURE_FLAG_KEYS, listFeatureFlags } from "@isp/db";
import { requireGrantedOperator } from "@/lib/platform-admin";
import { createBetaInviteAction, setFeatureFlagAction } from "@/app/admin-actions";

export const dynamic = "force-dynamic";

export default async function AdminBetaPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; token?: string }>;
}) {
  const operator = await requireGrantedOperator();
  if (!operator.adminDb) {
    return <p className="muted">Beta controls need the platform admin database role.</p>;
  }
  const flags = await listFeatureFlags(operator.adminDb);
  const query = await searchParams;

  return (
    <>
      <h1>Beta controls</h1>
      <p className="muted">
        Invites store only a token hash. Predictions stay shadow unless the platform flag is on.
        Do not paste the one-time token into tickets or logs.
      </p>
      {query.error ? <p className="form-error">Beta action was rejected.</p> : null}
      {query.token ? (
        <p className="form-error">
          One-time invite token (shown once): <code>{query.token}</code>
        </p>
      ) : null}
      <h2>Invitations</h2>
      <form className="auth-form" action={createBetaInviteAction}>
        <label>
          Email (optional)
          <input name="email" type="email" />
        </label>
        <label>
          Organization hint
          <input name="organizationHint" />
        </label>
        <label>
          Cohort
          <select name="cohort" defaultValue="beta_wave_1">
            {BETA_COHORTS.map((cohort) => (
              <option key={cohort} value={cohort}>
                {cohort}
              </option>
            ))}
          </select>
        </label>
        <label>
          Days valid
          <input name="days" type="number" min={1} max={90} defaultValue={14} />
        </label>
        <label>
          Max uses
          <input name="maxUses" type="number" min={1} max={20} defaultValue={1} />
        </label>
        <button type="submit">Create invite</button>
      </form>
      <h2>Feature flags</h2>
      <ul>
        {flags.map((flag) => (
          <li key={flag.flagKey}>
            {flag.flagKey} · {flag.enabled ? "on" : "off"}
            <form className="inline-form" action={setFeatureFlagAction}>
              <input type="hidden" name="key" value={flag.flagKey} />
              <input type="hidden" name="enabled" value={flag.enabled ? "false" : "true"} />
              <button type="submit">{flag.enabled ? "Disable" : "Enable"}</button>
            </form>
          </li>
        ))}
      </ul>
      <p className="muted">Known keys: {FEATURE_FLAG_KEYS.join(", ")}.</p>
    </>
  );
}
