import {
  listIntelligenceQuarantineForAdmin,
  listMarketQuarantineForAdmin,
} from "@isp/db";
import { requireGrantedOperator } from "@/lib/platform-admin";
import { reviewQuarantineAction } from "@/app/admin-actions";

export const dynamic = "force-dynamic";

export default async function AdminQuarantinePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const operator = await requireGrantedOperator();
  const query = await searchParams;
  if (!operator.adminDb) {
    return <p className="muted">Quarantine inspection needs the platform admin database role.</p>;
  }
  const [market, intel] = await Promise.all([
    listMarketQuarantineForAdmin(operator.adminDb),
    listIntelligenceQuarantineForAdmin(operator.adminDb),
  ]);

  return (
    <>
      <h1>Quarantine</h1>
      <p className="muted">Safe payload summaries only. Raw secrets are never shown. Every action is audited.</p>
      {query.error ? <p className="form-error">Quarantine action was rejected.</p> : null}
      <h2>Market</h2>
      {market.map((row) => (
        <section key={row.id}>
          <p>
            {row.sourceKey} · {row.reason} · {row.receivedAt.toISOString()} · {row.resolutionState}
          </p>
          <pre>{JSON.stringify(row.payloadSummary)}</pre>
          <form className="inline-form" action={reviewQuarantineAction}>
            <input type="hidden" name="kind" value="market" />
            <input type="hidden" name="id" value={row.id} />
            <label>
              Action
              <select name="action" defaultValue="dismiss">
                <option value="retry">retry</option>
                <option value="resolve_identity">resolve identity</option>
                <option value="dismiss">dismiss</option>
              </select>
            </label>
            <label>
              Printing id
              <input name="printingId" />
            </label>
            <label>
              Namespace
              <input name="sourceNamespace" />
            </label>
            <label>
              Identifier type
              <input name="identifierType" />
            </label>
            <label>
              Identifier value
              <input name="identifierValue" />
            </label>
            <label>
              Reason
              <input name="reason" required />
            </label>
            <button type="submit">Record</button>
          </form>
        </section>
      ))}
      <h2>Intelligence</h2>
      {intel.map((row) => (
        <section key={row.id}>
          <p>
            {row.providerKey} · {row.recordType} · {row.reason} · {row.receivedAt.toISOString()} · {row.resolutionState}
          </p>
          <pre>{JSON.stringify(row.payloadSummary)}</pre>
          <form className="inline-form" action={reviewQuarantineAction}>
            <input type="hidden" name="kind" value="intelligence" />
            <input type="hidden" name="id" value={row.id} />
            <label>
              Action
              <select name="action" defaultValue="dismissed">
                <option value="retried">retry</option>
                <option value="resolved">resolve</option>
                <option value="dismissed">dismiss</option>
              </select>
            </label>
            <label>
              Reason
              <input name="reason" required />
            </label>
            <button type="submit">Record</button>
          </form>
        </section>
      ))}
    </>
  );
}
