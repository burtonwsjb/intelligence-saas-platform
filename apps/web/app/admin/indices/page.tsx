import { listOperatorIndexDefinitions } from "@isp/db";
import { AdminHeader } from "@/components/Admin";
import { requireGrantedOperator } from "@/lib/platform-admin";
import { upsertIndexAction } from "@/app/admin-actions";

export const dynamic = "force-dynamic";

export default async function AdminIndicesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const operator = await requireGrantedOperator();
  if (!operator.adminDb) {
    return <p className="muted">Index specs need the platform admin database role.</p>;
  }
  const rows = await listOperatorIndexDefinitions(operator.adminDb);
  const query = await searchParams;

  return (
    <>
      <AdminHeader icon="indices" title="Indices" description="Market index definitions by language. Existing keys are never rewritten." />
      {query.error ? <p className="form-error">Index upsert was rejected.</p> : null}
      <form className="auth-form" action={upsertIndexAction}>
        <label>
          Index key
          <input name="indexKey" required />
        </label>
        <label>
          Name
          <input name="name" required />
        </label>
        <label>
          Game key
          <input name="gameKey" defaultValue="pokemon" required />
        </label>
        <label>
          Language
          <input name="languageCode" defaultValue="en" required />
        </label>
        <button type="submit">Create definition</button>
      </form>
      <ul>
        {rows.map((row) => (
          <li key={row.indexKey}>
            {row.indexKey} — {row.name} · {row.gameKey} · {row.languageCode ?? "mixed"} ·{" "}
            {row.status}
          </li>
        ))}
      </ul>
    </>
  );
}
