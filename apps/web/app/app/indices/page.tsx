import { EmptyState } from "@/components/EmptyState";
import { loadAppAccess } from "@/lib/app-access";
import { getDb } from "@/lib/auth";
import { listIndexOverview } from "@isp/db";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function IndicesPage() {
  await loadAppAccess();
  const rows = await listIndexOverview(getDb());

  return (
    <>
      <h1>Indices</h1>
      <p className="muted">Language-scoped market indices. Coverage and methodology stay visible.</p>
      {rows.length === 0 ? (
        <EmptyState title="No indices" body="Index definitions are created by analytics jobs." />
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={row.definition.indexKey}>
              <Link href={`/app/indices/${encodeURIComponent(row.definition.indexKey)}`}>
                {row.definition.name}
              </Link>
              {" — "}
              {row.definition.gameKey}
              {row.definition.languageCode ? ` · ${row.definition.languageCode}` : ""}
              {row.latest ? ` · ${Number(row.latest.indexValue).toFixed(2)} · coverage ${row.latest.coverage}` : ""}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
