import { BETA_COHORTS, FEATURE_FLAG_KEYS, listFeatureFlags } from "@isp/db";
import { AdminHeader } from "@/components/Admin";
import { requireGrantedOperator } from "@/lib/platform-admin";
import { createBetaInviteAction, setFeatureFlagAction } from "@/app/admin-actions";
import { readSecretFlash } from "@/lib/secret-flash";

export const dynamic = "force-dynamic";

export default async function AdminBetaPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const operator = await requireGrantedOperator();
  if (!operator.adminDb) {
    return <p className="muted">Beta controls need the platform admin database role.</p>;
  }
  const flags = await listFeatureFlags(operator.adminDb);
  const query = await searchParams;
  const token = await readSecretFlash("beta_invite");

  return (
    <>
      <AdminHeader icon="beta" title="Invites & features" description="Invite people to the beta and switch platform features on or off. Invite links are shown once." />
      {query.error ? <p className="form-error">Beta action was rejected.</p> : null}
      {token ? (
        <div className="notice notice-info" role="status">
          <span>
            One-time invite token (shown once): <code>{token}</code>
          </span>
        </div>
      ) : null}
      <h2 id="invite">Invite someone</h2>
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
        <button type="submit">Create invite link</button>
      </form>
      <h2>Feature switches</h2>
      <ul>
        {flags.map((flag) => (
          <li key={flag.flagKey}>
            <span style={{ flex: 1 }}>
              <strong>{flag.flagKey.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase())}</strong>
              <span className="subtle"> · {flag.enabled ? "On" : "Off"}</span>
            </span>
            <form action={setFeatureFlagAction}>
              <input type="hidden" name="key" value={flag.flagKey} />
              <input type="hidden" name="enabled" value={flag.enabled ? "false" : "true"} />
              <button
                type="submit"
                className={`switch${flag.enabled ? " on" : ""}`}
                role="switch"
                aria-checked={flag.enabled}
                aria-label={`${flag.flagKey}: ${flag.enabled ? "on" : "off"}`}
              >
                <span className="switch-knob" />
              </button>
            </form>
          </li>
        ))}
      </ul>
      <p className="muted">Known keys: {FEATURE_FLAG_KEYS.join(", ")}.</p>
    </>
  );
}
