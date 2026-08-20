import { inspectTenant } from "@isp/db";
import { requireGrantedOperator } from "@/lib/platform-admin";
import { addOperatorNoteAction } from "@/app/admin-actions";

export const dynamic = "force-dynamic";

export default async function AdminCustomerDetailPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const operator = await requireGrantedOperator();
  const { organizationId } = await params;
  if (!operator.adminDb) {
    return <p className="muted">Break-glass inspection needs the platform admin database role.</p>;
  }
  const workspace = await inspectTenant(operator.adminDb, {
    organizationId,
    actorUserId: operator.session.user.id,
  });

  return (
    <>
      <h1>{workspace.profile?.displayName ?? organizationId}</h1>
      <p className="muted">
        Audited inspection. This is not session impersonation. Stripe IDs and secrets are omitted.
      </p>
      <ul>
        <li>Stage: {workspace.profile?.lifecycleStage ?? "none"}</li>
        <li>Customer status: {workspace.profile?.customerStatus ?? "none"}</li>
        <li>Plan: {workspace.billing?.planKey ?? "none"}</li>
        <li>Billing: {workspace.billing?.status ?? "none"}</li>
        <li>Trial ends: {workspace.billing?.trialEndsAt?.toISOString() ?? "n/a"}</li>
        <li>Health: {workspace.health?.overall ?? "n/a"}</li>
      </ul>
      {workspace.health ? (
        <ul>
          {workspace.health.components.map((component) => (
            <li key={component.key}>
              {component.key}: {component.score} — {component.reason}
            </li>
          ))}
        </ul>
      ) : null}
      <h2>Tags</h2>
      <p>{workspace.tags.map((tag) => tag.tagKey).join(", ") || "none"}</p>
      <h2>Timeline</h2>
      <ul>
        {workspace.events.map((event) => (
          <li key={event.id}>
            {event.eventType} · {event.createdAt.toISOString()}
          </li>
        ))}
      </ul>
      <h2>Operator notes</h2>
      <form className="auth-form" action={addOperatorNoteAction}>
        <input type="hidden" name="organizationId" value={organizationId} />
        <label>
          Note
          <input name="body" required maxLength={4000} />
        </label>
        <button type="submit">Add note</button>
      </form>
      <ul>
        {workspace.notes.map((note) => (
          <li key={note.id}>
            {note.category}: {note.body}
          </li>
        ))}
      </ul>
    </>
  );
}
