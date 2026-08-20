import Link from "next/link";
import {
  listActiveCustomers,
  listAtRiskCustomers,
  listCanceledCustomers,
  listCrmCustomers,
  listPastDueCustomers,
  listRecentSignups,
  listTrialCustomers,
} from "@isp/db";
import { requireGrantedOperator } from "@/lib/platform-admin";

export const dynamic = "force-dynamic";

export default async function AdminCustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const operator = await requireGrantedOperator();
  if (!operator.adminDb) {
    return <p className="muted">Customer listings need the platform admin database role.</p>;
  }
  const view = (await searchParams).view ?? "all";
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const rows =
    view === "trial"
      ? await listTrialCustomers(operator.adminDb)
      : view === "active"
        ? await listActiveCustomers(operator.adminDb)
        : view === "past_due"
          ? await listPastDueCustomers(operator.adminDb)
          : view === "canceled"
            ? await listCanceledCustomers(operator.adminDb)
            : view === "at_risk"
              ? await listAtRiskCustomers(operator.adminDb)
              : view === "recent"
                ? await listRecentSignups(operator.adminDb, since)
                : await listCrmCustomers(operator.adminDb);

  return (
    <>
      <h1>Customers</h1>
      <p className="muted">Phase 17 CRM listings. Operator notes stay off tenant surfaces.</p>
      <p>
        <Link href="/admin/customers">all</Link>
        {" · "}
        <Link href="/admin/customers?view=trial">trials</Link>
        {" · "}
        <Link href="/admin/customers?view=active">active</Link>
        {" · "}
        <Link href="/admin/customers?view=past_due">past due</Link>
        {" · "}
        <Link href="/admin/customers?view=canceled">canceled</Link>
        {" · "}
        <Link href="/admin/customers?view=at_risk">at risk</Link>
        {" · "}
        <Link href="/admin/customers?view=recent">recent</Link>
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th>Organization</th>
            <th>Stage</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.organizationId}>
              <td>
                <Link href={`/admin/customers/${row.organizationId}`}>{row.displayName}</Link>
              </td>
              <td>{row.lifecycleStage}</td>
              <td>{row.customerStatus}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
