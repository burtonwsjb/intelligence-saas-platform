import { listPredictionsForOperator } from "@isp/db";
import { AdminHeader } from "@/components/Admin";
import { requireGrantedOperator } from "@/lib/platform-admin";

export const dynamic = "force-dynamic";

export default async function AdminPredictionsPage() {
  const operator = await requireGrantedOperator();
  if (!operator.adminDb) {
    return <p className="muted">Shadow prediction preview needs the platform admin database role.</p>;
  }
  const rows = await listPredictionsForOperator(operator.adminDb, operator.session.user.id);

  return (
    <>
      <AdminHeader icon="forecast" title="Forecasts" description="Internal preview. Customers only see forecasts when the feature switch is on." />
      <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Printing</th>
            <th>Visibility</th>
            <th>Horizon</th>
            <th>Language</th>
            <th>Quality</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{row.printingId}</td>
              <td>{row.visibility}</td>
              <td>{row.horizon}</td>
              <td>{row.languageCode}</td>
              <td>{row.dataQuality}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </>
  );
}
