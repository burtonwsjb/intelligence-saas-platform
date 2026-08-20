import { listPredictionsForOperator } from "@isp/db";
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
      <h1>Prediction preview</h1>
      <p className="muted">
        Internal only. Customer UI stays gated on entitlement plus PREDICTIONS_CUSTOMER_VISIBLE.
        Shadow rows are listed here and never published by this page.
      </p>
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
    </>
  );
}
