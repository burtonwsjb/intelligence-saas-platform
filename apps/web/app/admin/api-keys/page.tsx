import Link from "next/link";
import { CUSTOMER_READ_SCOPES, DEFAULT_OPERATOR_KEY_RATE_LIMIT, ISSUABLE_SCOPES } from "@isp/auth";
import { listApiAccessWorkspaces, listOperatorApiKeys } from "@isp/db";
import { AdminCard, AdminHeader, Notice, StatusPill } from "@/components/Admin";
import { requireGrantedOperator } from "@/lib/platform-admin";
import { readSecretFlash } from "@/lib/secret-flash";
import { CUSTOMER_API_ENDPOINTS, SCOPE_LABELS, customerApiBaseUrl } from "@/lib/api-docs";
import {
  issueCustomerApiKeyAction,
  revokeCustomerApiKeyAction,
  rotateCustomerApiKeyAction,
  updateCustomerApiKeyAction,
  setApiRequestLimitAction,
} from "@/app/admin-actions";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  config: "The platform admin database role is not configured, so keys cannot be issued from here.",
  name: "Give the key a name of 1 to 80 characters.",
  scopes: "Pick at least one kind of data the key can read.",
  pepper: "API_KEY_PEPPER is not set on the web app, so keys cannot be created.",
  rate: "Requests per minute must be a whole number from 1 to 10,000, or empty for no per-key limit.",
  limit: "The monthly request limit must be a whole number (leave it empty to use the plan's limit).",
  rejected: "That change was rejected. Check the workspace and try again.",
};

const DONE: Record<string, string> = {
  issued: "Key issued. Copy it now: it is shown only once.",
  revoked: "Key revoked. Calls with it stop working right away.",
  rotated: "Key rotated: the old key stopped working. Copy the new one now, it is shown only once.",
  updated: "Key settings saved.",
  limit: "Monthly request limit saved.",
};

function day(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : "—";
}

export default async function AdminApiKeysPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; done?: string; workspace?: string }>;
}) {
  const operator = await requireGrantedOperator();
  if (!operator.adminDb) {
    return <p className="muted">{ERRORS.config}</p>;
  }
  const query = await searchParams;
  let keys: Awaited<ReturnType<typeof listOperatorApiKeys>>;
  let workspaces: Awaited<ReturnType<typeof listApiAccessWorkspaces>>;
  try {
    [keys, workspaces] = await Promise.all([
      listOperatorApiKeys(operator.adminDb),
      listApiAccessWorkspaces(operator.adminDb),
    ]);
  } catch (error) {
    // api_key.request_count and friends arrive with migration 0047.
    if (/request_count|rate_limit_per_minute|issued_by_operator/.test(String(error))) {
      return (
        <Notice tone="bad">
          Run <code>0047_api_key_limits.sql</code> in the Neon SQL editor first; this page needs its new columns.
        </Notice>
      );
    }
    throw error;
  }
  const created = await readSecretFlash("api_key");
  const baseUrl = customerApiBaseUrl();
  const activeKeys = keys.filter((key) => key.status === "active" && !key.revokedAt);
  const requestsThisMonth = workspaces.reduce((sum, row) => sum + row.requestsThisMonth, 0);

  return (
    <>
      <AdminHeader
        icon="key"
        title="API access"
        description="Give a customer workspace an API key so they can pull cards, prices, sentiment and influencer data into their own tools. Keys are read-only unless you tick a write scope."
      />
      {query.error && ERRORS[query.error] ? <Notice tone="bad">{ERRORS[query.error]}</Notice> : null}
      {query.done && DONE[query.done] && !created ? <Notice tone="good">{DONE[query.done]}</Notice> : null}
      {created ? (
        <Notice tone="good">
          <span>
            New key (copy it now, it is shown only once): <code>{created}</code>
          </span>
        </Notice>
      ) : null}

      <div className="kpi-row">
        <div className="kpi">
          <span className="kpi-label">Active keys</span>
          <strong className="kpi-value">{activeKeys.length.toLocaleString()}</strong>
        </div>
        <div className="kpi">
          <span className="kpi-label">Workspaces with a key</span>
          <strong className="kpi-value">
            {new Set(activeKeys.map((key) => key.organizationId)).size.toLocaleString()}
          </strong>
        </div>
        <div className="kpi">
          <span className="kpi-label">API requests this month</span>
          <strong className="kpi-value">{requestsThisMonth.toLocaleString()}</strong>
        </div>
      </div>

      <AdminCard
        title="Issue a key"
        icon="plus"
        description="The customer needs a workspace first: they sign up at the site, or you invite them from Invites & features."
      >
        {workspaces.length === 0 ? (
          <p className="muted">No workspaces yet.</p>
        ) : (
          <form className="auth-form" action={issueCustomerApiKeyAction}>
            <label>
              Workspace
              <select name="organizationId" required defaultValue={query.workspace ?? ""}>
                <option value="" disabled>
                  Choose a workspace
                </option>
                {workspaces.map((row) => (
                  <option key={row.organizationId} value={row.organizationId}>
                    {row.name}
                    {row.ownerEmail ? ` (${row.ownerEmail})` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Key name
              <input name="name" required maxLength={80} placeholder="e.g. Acme price tracker" />
            </label>
            <label>
              Requests per minute (empty for no per-key limit)
              <input name="rateLimitPerMinute" type="number" min={1} max={10000} defaultValue={DEFAULT_OPERATOR_KEY_RATE_LIMIT} />
            </label>
            <label>
              Expires (optional)
              <input name="expiresAt" type="date" />
            </label>
            <label>
              Note (who it is for, plan, contact)
              <input name="note" maxLength={500} />
            </label>
            <fieldset>
              <legend>What the key can read</legend>
              {ISSUABLE_SCOPES.map((scope) => (
                <label key={scope}>
                  <input
                    type="checkbox"
                    name="scopes"
                    value={scope}
                    defaultChecked={(CUSTOMER_READ_SCOPES as readonly string[]).includes(scope)}
                  />
                  {SCOPE_LABELS[scope] ?? scope} <span className="subtle">({scope})</span>
                </label>
              ))}
            </fieldset>
            <button type="submit">Issue key</button>
          </form>
        )}
      </AdminCard>

      <AdminCard title="Keys" icon="key" description="Every customer key, newest first. Only the prefix is stored in readable form.">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Workspace</th>
                <th>Key</th>
                <th>Can read</th>
                <th>Status</th>
                <th>Requests this month</th>
                <th>Last used</th>
                <th>Expires</th>
                <th>Per minute and note</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.length === 0 ? (
                <tr>
                  <td colSpan={9}>No keys yet.</td>
                </tr>
              ) : (
                keys.map((key) => {
                  const expired = key.expiresAt !== null && key.expiresAt.getTime() <= Date.now();
                  const active = key.status === "active" && !key.revokedAt && !expired;
                  return (
                    <tr key={key.id}>
                      <td>{key.organizationName}</td>
                      <td>
                        {key.name}
                        <br />
                        <code className="subtle">{key.prefix}_…</code>
                        <div className="subtle">{key.issuedByOperator ? "Issued by admin" : "Made by the workspace"}</div>
                      </td>
                      <td>{key.scopes.map((scope) => SCOPE_LABELS[scope] ?? scope).join(", ")}</td>
                      <td>
                        <StatusPill tone={active ? "good" : expired ? "warn" : "bad"}>
                          {active ? "Active" : expired ? "Expired" : "Revoked"}
                        </StatusPill>
                      </td>
                      <td>
                        {key.requestsThisMonth.toLocaleString()}
                        <div className="subtle">{key.requestCount.toLocaleString()} all time</div>
                      </td>
                      <td>{day(key.lastUsedAt)}</td>
                      <td>{key.expiresAt ? day(key.expiresAt) : "Never"}</td>
                      <td>
                        {active ? (
                          <form className="inline-form" action={updateCustomerApiKeyAction}>
                            <input type="hidden" name="apiKeyId" value={key.id} />
                            <input type="hidden" name="organizationId" value={key.organizationId} />
                            <input
                              name="rateLimitPerMinute"
                              inputMode="numeric"
                              aria-label={`Requests per minute for ${key.name}`}
                              placeholder="No limit"
                              defaultValue={key.rateLimitPerMinute ?? ""}
                              size={6}
                            />
                            <input name="note" aria-label={`Note for ${key.name}`} placeholder="Note" defaultValue={key.note ?? ""} maxLength={500} size={14} />
                            <button type="submit" className="secondary">
                              Save
                            </button>
                          </form>
                        ) : (
                          <span className="subtle">
                            {key.rateLimitPerMinute ? `${key.rateLimitPerMinute}/min` : "No limit"}
                            {key.note ? ` · ${key.note}` : ""}
                          </span>
                        )}
                      </td>
                      <td>
                        {active ? (
                          <div className="inline-form">
                            <form action={rotateCustomerApiKeyAction}>
                              <input type="hidden" name="apiKeyId" value={key.id} />
                              <input type="hidden" name="organizationId" value={key.organizationId} />
                              <button type="submit" className="secondary">
                                Rotate
                              </button>
                            </form>
                            <form action={revokeCustomerApiKeyAction}>
                              <input type="hidden" name="apiKeyId" value={key.id} />
                              <input type="hidden" name="organizationId" value={key.organizationId} />
                              <button type="submit" className="danger">
                                Revoke
                              </button>
                            </form>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </AdminCard>

      <AdminCard
        title="Monthly request limits"
        icon="usage"
        description="Each workspace gets its plan's monthly API allowance. Type a number to give one workspace its own allowance, or leave it empty to go back to the plan."
      >
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Workspace</th>
                <th>Plan</th>
                <th>Active keys</th>
                <th>Requests this month</th>
                <th>Own limit</th>
              </tr>
            </thead>
            <tbody>
              {workspaces.map((row) => (
                <tr key={row.organizationId}>
                  <td>
                    {row.name}
                    {row.ownerEmail ? <div className="subtle">{row.ownerEmail}</div> : null}
                  </td>
                  <td>
                    {row.planKey}
                    {row.billingStatus !== "none" ? <span className="subtle"> · {row.billingStatus}</span> : null}
                  </td>
                  <td>{row.activeKeys}</td>
                  <td>{row.requestsThisMonth.toLocaleString()}</td>
                  <td>
                    <form className="inline-form" action={setApiRequestLimitAction}>
                      <input type="hidden" name="organizationId" value={row.organizationId} />
                      <input
                        name="limit"
                        inputMode="numeric"
                        aria-label={`Monthly request limit for ${row.name}`}
                        placeholder="Plan limit"
                        defaultValue={row.requestLimitOverride ?? ""}
                        size={10}
                      />
                      <button type="submit" className="secondary">
                        Save
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="subtle">
          While the site runs in staging mode (ISP_ENV=staging) every workspace is also capped at 10,000 requests a
          month and 3 keys of its own, whatever the plan or limit says.
        </p>
      </AdminCard>

      <AdminCard title="What to send the customer" icon="external" description="Their key goes in the Authorization header. All answers are JSON.">
        <pre className="code-block">
          {`curl -H "Authorization: Bearer <their key>" \\\n  "${baseUrl}/v1/printings?q=charizard&game=pokemon&limit=5"`}
        </pre>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Call</th>
                <th>Returns</th>
                <th>Needs</th>
              </tr>
            </thead>
            <tbody>
              {CUSTOMER_API_ENDPOINTS.map((endpoint) => (
                <tr key={endpoint.path}>
                  <td>
                    <code>{endpoint.path}</code>
                  </td>
                  <td>{endpoint.what}</td>
                  <td>{SCOPE_LABELS[endpoint.scope] ?? endpoint.scope}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="subtle">
          Full docs to send the customer: <Link href="/admin/api-docs">API docs</Link> (admin only; copy what they need). Machine-readable list:{" "}
          <code>{baseUrl}/v1/openapi.json</code>. Lists page with <code>?limit=</code> (up to 100) and the{" "}
          <code>next_cursor</code> in each answer.
        </p>
      </AdminCard>
    </>
  );
}
