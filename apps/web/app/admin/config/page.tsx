import { describePlatformConfig } from "@isp/db";
import { requireGrantedOperator } from "@/lib/platform-admin";

export const dynamic = "force-dynamic";

export default async function AdminConfigPage() {
  await requireGrantedOperator();
  const config = describePlatformConfig();

  return (
    <>
      <h1>Configuration</h1>
      <p className="muted">
        Display-only flags. Connection strings, API keys, webhook secrets, and Stripe IDs are never
        shown.
      </p>
      <table className="data-table">
        <tbody>
          {Object.entries(config).map(([key, value]) => (
            <tr key={key}>
              <td>{key}</td>
              <td>{String(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
