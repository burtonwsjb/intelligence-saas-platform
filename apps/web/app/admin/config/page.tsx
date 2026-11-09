import { describePlatformConfig } from "@isp/db";
import { AdminHeader } from "@/components/Admin";
import { requireGrantedOperator } from "@/lib/platform-admin";

export const dynamic = "force-dynamic";

export default async function AdminConfigPage() {
  await requireGrantedOperator();
  const config = describePlatformConfig();

  return (
    <>
      <AdminHeader icon="config" title="Configuration" description="What is set up on this server. Connection strings, keys and secrets are never shown." />
      <div className="table-wrap">
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
      </div>
    </>
  );
}
