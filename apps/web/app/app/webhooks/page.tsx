import {
  createWebhookAction,
  deleteWebhookAction,
  disableWebhookAction,
  rotateWebhookAction,
} from "@/app/webhook-actions";
import { EmptyState, LockedFeature } from "@/components/EmptyState";
import { loadAppAccess } from "@/lib/app-access";
import { getDb } from "@/lib/auth";
import { WEBHOOK_EVENT_TYPES, listWebhookDeliveries, listWebhookEndpoints, withOrganizationContext } from "@isp/db";

export const dynamic = "force-dynamic";

export default async function WebhooksPage({
  searchParams,
}: {
  searchParams: Promise<{ created?: string; error?: string }>;
}) {
  const { organizationId, userId, access } = await loadAppAccess();
  const query = await searchParams;
  if (!access.hasWebhooks) {
    return (
      <LockedFeature
        title="Webhooks"
        body="Webhook endpoints are not entitled on this plan."
      />
    );
  }
  const snapshot = await withOrganizationContext(getDb(), { organizationId, userId }, async (scoped) => {
    const endpoints = await listWebhookEndpoints(scoped, organizationId);
    const deliveries = await listWebhookDeliveries(scoped, organizationId);
    return { endpoints, deliveries };
  });

  return (
    <>
      <h1>Webhooks</h1>
      <p className="muted">
        Signing secrets are shown once at create/rotate. Stored ciphertext is never displayed again.
      </p>
      {query.created ? (
        <p>
          Signing secret (copy now): <code>{query.created}</code>
        </p>
      ) : null}
      {query.error ? <p className="form-error">Webhook action was rejected.</p> : null}
      {access.canManageApiKeys ? (
        <form className="auth-form" action={createWebhookAction}>
          <label>
            Endpoint URL
            <input name="url" required placeholder="https://example.com/hooks/isp" />
          </label>
          {WEBHOOK_EVENT_TYPES.map((event) => (
            <label key={event}>
              <input type="checkbox" name="events" value={event} />
              {event}
            </label>
          ))}
          <button type="submit">Create endpoint</button>
        </form>
      ) : (
        <p className="muted">Your role cannot create or rotate webhooks.</p>
      )}
      {snapshot.endpoints.length === 0 ? (
        <EmptyState title="No endpoints" body="Create a public HTTPS endpoint to receive signed events." />
      ) : (
        <ul>
          {snapshot.endpoints.map((endpoint) => {
            const latest = snapshot.deliveries
              .filter((row) => row.endpointId === endpoint.id)
              .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
            return (
              <li key={endpoint.id}>
                {endpoint.url} · {endpoint.status} · {endpoint.eventTypes.join(", ")} · failures{" "}
                {endpoint.consecutiveFailures}
                {latest ? ` · last ${latest.status} ${latest.createdAt.toISOString()}` : " · no deliveries"}
                {access.canManageApiKeys ? (
                  <>
                    {endpoint.status === "active" ? (
                      <form action={disableWebhookAction}>
                        <input type="hidden" name="endpointId" value={endpoint.id} />
                        <button className="link-button" type="submit">
                          Disable
                        </button>
                      </form>
                    ) : null}
                    <form action={rotateWebhookAction}>
                      <input type="hidden" name="endpointId" value={endpoint.id} />
                      <button className="link-button" type="submit">
                        Rotate secret
                      </button>
                    </form>
                    <form action={deleteWebhookAction}>
                      <input type="hidden" name="endpointId" value={endpoint.id} />
                      <button className="link-button" type="submit">
                        Delete
                      </button>
                    </form>
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
