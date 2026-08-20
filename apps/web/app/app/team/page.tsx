import {
  cancelInvitationAction,
  changeRoleAction,
  inviteMemberAction,
  removeMemberAction,
} from "@/app/team-actions";
import { loadAppAccess } from "@/lib/app-access";
import { getDb } from "@/lib/auth";
import { INVITABLE_ROLES, invitation, member, user } from "@isp/db";
import { and, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId, access } = await loadAppAccess();
  const query = await searchParams;
  const members = await getDb()
    .select({
      id: member.id,
      role: member.role,
      userId: member.userId,
      email: user.email,
      name: user.name,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, organizationId));
  const invites = await getDb()
    .select()
    .from(invitation)
    .where(and(eq(invitation.organizationId, organizationId), eq(invitation.status, "pending")));

  return (
    <>
      <h1>Team</h1>
      <p className="muted">Organization membership uses Phase 03 RBAC. This is not the platform admin surface.</p>
      {query.error ? <p className="form-error">Team change was rejected.</p> : null}
      <ul>
        {members.map((row) => (
          <li key={row.id}>
            {row.email} · {row.role}
            {access.canManageMembers ? (
              <>
                <form className="inline-form" action={changeRoleAction}>
                  <input type="hidden" name="memberId" value={row.id} />
                  <select name="role" defaultValue={row.role}>
                    <option value="owner">owner</option>
                    {INVITABLE_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                  <button type="submit">Change role</button>
                </form>
                {row.role !== "owner" ? (
                  <form action={removeMemberAction}>
                    <input type="hidden" name="memberId" value={row.id} />
                    <button className="link-button" type="submit">
                      Remove
                    </button>
                  </form>
                ) : null}
              </>
            ) : null}
          </li>
        ))}
      </ul>
      {access.canManageMembers ? (
        <>
          <h2>Invite</h2>
          <form className="auth-form" action={inviteMemberAction}>
            <label>
              Email
              <input name="email" type="email" required />
            </label>
            <label>
              Role
              <select name="role" defaultValue="viewer">
                {INVITABLE_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit">Send invitation</button>
          </form>
        </>
      ) : (
        <p className="muted">Viewer and other non-admin roles cannot invite or change members.</p>
      )}
      <h2>Pending invitations</h2>
      <ul>
        {invites.map((row) => (
          <li key={row.id}>
            {row.email} · {row.role} · expires {row.expiresAt.toISOString()}
            {access.canManageMembers ? (
              <form action={cancelInvitationAction}>
                <input type="hidden" name="invitationId" value={row.id} />
                <button className="link-button" type="submit">
                  Cancel
                </button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}
