import { SUPPORT_CASE_STATUSES, listSupportCases } from "@isp/db";
import { requireGrantedOperator } from "@/lib/platform-admin";
import { createSupportCaseAction, setSupportStatusAction } from "@/app/admin-actions";

export const dynamic = "force-dynamic";

export default async function AdminSupportPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const operator = await requireGrantedOperator();
  if (!operator.adminDb) {
    return <p className="muted">Support cases need the platform admin database role.</p>;
  }
  const cases = await listSupportCases(operator.adminDb);
  const query = await searchParams;

  return (
    <>
      <h1>Support</h1>
      <p className="muted">Operator-only cases. Tenants cannot read this table.</p>
      {query.error ? <p className="form-error">Support action was rejected.</p> : null}
      <form className="auth-form" action={createSupportCaseAction}>
        <label>
          Organization id
          <input name="organizationId" required />
        </label>
        <label>
          Subject
          <input name="subject" required />
        </label>
        <label>
          Body
          <input name="body" required />
        </label>
        <button type="submit">Open case</button>
      </form>
      <ul>
        {cases.map((row) => (
          <li key={row.id}>
            {row.subject} · {row.status} · {row.organizationId}
            <form className="inline-form" action={setSupportStatusAction}>
              <input type="hidden" name="id" value={row.id} />
              <select name="status" defaultValue={row.status}>
                {SUPPORT_CASE_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
              <button type="submit">Update</button>
            </form>
          </li>
        ))}
      </ul>
    </>
  );
}
