import { listBreakGlassAudit } from "@isp/db";
import { AdminHeader } from "@/components/Admin";
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
      <AdminHeader icon="audit" title="Audit log" description="Every operator action, append-only. Secrets are stripped from the details." />
      <div className="table-wrap">
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
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4}>No break-glass events yet.</td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.id}>
                <td>{row.createdAt.toISOString()}</td>
                <td>{row.action}</td>
                <td>{row.actorUserId}</td>
                <td>
                  {row.targetType ?? ""} {row.targetId ?? row.organizationId ?? ""}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      </div>
    </>
  );
}
