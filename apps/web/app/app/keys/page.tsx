import { requirePageOrganization } from "@/lib/session";
import { getDb } from "@/lib/auth";
import { listApiKeys, member, withOrganizationContext } from "@isp/db";
import { ISSUABLE_SCOPES, hasPermission } from "@isp/auth";
import { and, eq } from "drizzle-orm";
import { createApiKeyAction, revokeApiKeyAction, rotateApiKeyAction } from "@/app/key-actions";

export const dynamic = "force-dynamic";

export default async function ApiKeysPage({
  searchParams,
}: {
  searchParams: Promise<{ created?: string }>;
}) {
  const { session, organizationId } = await requirePageOrganization();
  const query = await searchParams;
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
        Tenant-bound test credentials. The full secret is shown once on create or rotate. Prefix, last used, and
        expiration remain visible.
      </p>
      {query.created ? (
        <p>
          Secret (copy now): <code>{query.created}</code>
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
              <input type="checkbox" name="scopes" value={scope} defaultChecked={scope === "decisions:read"} />
              {scope}
            </label>
          ))}
          <button type="submit">Create key</button>
        </form>
      ) : (
        <p className="muted">Your role cannot create, rotate, or revoke API keys.</p>
      )}
      <ul>
        {keys.map((key) => (
          <li key={key.id}>
            {key.name} — {key.prefix} — {key.status} — scopes {key.scopes}
            {" — last used "}
            {key.lastUsedAt ? key.lastUsedAt.toISOString() : "never"}
            {" — expires "}
            {key.expiresAt ? key.expiresAt.toISOString() : "none"}
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
