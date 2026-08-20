import { listBreakGlassAudit } from "@isp/db";
import { requireGrantedOperator } from "@/lib/platform-admin";

export const dynamic = "force-dynamic";

export default async function AdminAuditPage() {
  const operator = await requireGrantedOperator();
  if (!operator.adminDb) {
    return <p className="muted">Break-glass audit needs the platform admin database role.</p>;
  }
  const rows = await listBreakGlassAudit(operator.adminDb);

  return (
    <>
      <h1>Break-glass audit</h1>
      <p className="muted">
        Separate from tenant audit_event. Append-only. Metadata is sanitized of secrets.
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Action</th>
            <th>Actor</th>
            <th>Target</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{row.createdAt.toISOString()}</td>
              <td>{row.action}</td>
              <td>{row.actorUserId}</td>
              <td>
                {row.targetType ?? ""} {row.targetId ?? row.organizationId ?? ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
