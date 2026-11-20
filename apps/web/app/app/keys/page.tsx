import Link from "next/link";
import { requirePageOrganization } from "@/lib/session";
import { getDb } from "@/lib/auth";
import { listApiKeys, member, withOrganizationContext } from "@isp/db";
import { CUSTOMER_READ_SCOPES, ISSUABLE_SCOPES, hasPermission } from "@isp/auth";
import { CUSTOMER_API_ENDPOINTS, SCOPE_LABELS, customerApiBaseUrl } from "@/lib/api-docs";
import { and, eq } from "drizzle-orm";
import { createApiKeyAction, revokeApiKeyAction, rotateApiKeyAction } from "@/app/key-actions";
import { readSecretFlash } from "@/lib/secret-flash";

export const dynamic = "force-dynamic";

export default async function ApiKeysPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { session, organizationId } = await requirePageOrganization();
  const query = await searchParams;
  const created = await readSecretFlash("api_key");
  const [membership] = await getDb()
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, session.user.id)))
    .limit(1);
  const canManage = hasPermission(membership?.role, "canManageApiKeys");
  const keys = await withOrganizationContext(
    getDb(),
    { organizationId, userId: session.user.id },
    (scoped) => listApiKeys(scoped, organizationId),
  );

  return (
    <>
      <h1>API keys</h1>
      <p className="muted">
        Use a key to pull Sentiment data (cards, prices, buy/sell readings, influencer calls) into your own tools. The
        full key is shown once when you create or rotate it; after that only its first characters are shown.
      </p>
      {query.error === "quota" ? (
        <p className="form-error">API key limit reached for the current plan.</p>
      ) : null}
      {created ? (
        <p>
          Secret (copy now): <code>{created}</code>
        </p>
      ) : null}
      {canManage ? (
        <form className="auth-form" action={createApiKeyAction}>
          <label>
            Name
            <input name="name" required maxLength={80} />
          </label>
          <label>
            Expires (optional)
            <input name="expiresAt" type="datetime-local" />
          </label>
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
          <button type="submit">Create key</button>
        </form>
      ) : (
        <p className="muted">Your role cannot create, rotate, or revoke API keys.</p>
      )}
      <h2>Using your key</h2>
      <p className="muted">
        Send the key in the Authorization header. Every answer is JSON. Full reference: <Link href="/developers">API docs</Link>.
      </p>
      <pre className="code-block">
        {`curl -H "Authorization: Bearer <your key>" \\\n  "${customerApiBaseUrl()}/v1/printings?q=charizard&game=pokemon&limit=5"`}
      </pre>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Call</th>
              <th>Returns</th>
            </tr>
          </thead>
          <tbody>
            {CUSTOMER_API_ENDPOINTS.map((endpoint) => (
              <tr key={endpoint.path}>
                <td>
                  <code>{endpoint.path}</code>
                </td>
                <td>{endpoint.what}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="subtle">
        Full reference: <code>{customerApiBaseUrl()}/v1/openapi.json</code>. Requests count toward your plan&apos;s
        monthly allowance (see Usage).
      </p>
      <h2>Your keys</h2>
      <ul>
        {keys.map((key) => (
          <li key={key.id}>
            {key.name} — {key.prefix} — {key.status} — scopes {key.scopes}
            {" — last used "}
            {key.lastUsedAt ? key.lastUsedAt.toISOString() : "never"}
            {" — expires "}
            {key.expiresAt ? key.expiresAt.toISOString() : "none"}
            {" — "}
            {Number(key.requestCount ?? 0).toLocaleString("en-US")} requests
            {key.rateLimitPerMinute ? ` — limit ${key.rateLimitPerMinute}/min` : ""}
            {canManage && key.status === "active" ? (
              <>
                <form action={rotateApiKeyAction}>
                  <input type="hidden" name="apiKeyId" value={key.id} />
                  <input type="hidden" name="name" value={`${key.name} rotated`} />
                  <input type="hidden" name="scopes" value={key.scopes} />
                  <button className="link-button" type="submit">
                    Rotate
                  </button>
                </form>
                <form action={revokeApiKeyAction}>
                  <input type="hidden" name="apiKeyId" value={key.id} />
                  <button className="link-button" type="submit">
                    Revoke
                  </button>
                </form>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}
