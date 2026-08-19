import { requirePageOrganization } from "@/lib/session";
import { getDb } from "@/lib/auth";
import { listApiKeys, member, withOrganizationContext } from "@isp/db";
import { hasPermission } from "@isp/auth";
import { and, eq } from "drizzle-orm";
import { createApiKeyAction, revokeApiKeyAction } from "@/app/key-actions";

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
        Keys are tenant-bound test credentials. The full secret is shown once.
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
            <input type="checkbox" name="scopes" value="decisions:read" defaultChecked />
            decisions:read
          </label>
          <label>
            <input type="checkbox" name="scopes" value="ingest:write" />
            ingest:write
          </label>
          <button type="submit">Create key</button>
        </form>
      ) : (
        <p className="muted">Your role cannot create or revoke API keys.</p>
      )}
      <ul>
        {keys.map((key) => (
          <li key={key.id}>
            {key.name} — {key.prefix} — {key.status}
            {canManage && key.status === "active" ? (
              <form action={revokeApiKeyAction}>
                <input type="hidden" name="apiKeyId" value={key.id} />
                <button className="link-button" type="submit">
                  Revoke
                </button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}
