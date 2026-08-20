import { EmptyState } from "@/components/EmptyState";
import { IdentityLine } from "@/components/IdentityLine";
import { loadAppAccess } from "@/lib/app-access";
import { getDb } from "@/lib/auth";
import { listPrintingCatalog } from "@isp/db";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function CardsPage({
  searchParams,
}: {
  searchParams: Promise<{ game?: string; language?: string; set?: string }>;
}) {
  await loadAppAccess();
  const query = await searchParams;
  const printings = await listPrintingCatalog(getDb(), {
    game: query.game || undefined,
    language: query.language || undefined,
    set: query.set || undefined,
  });

  return (
    <>
      <h1>Cards</h1>
      <p className="muted">Exact printing identity includes collector number, language, and variant.</p>
      <form className="filter-form" method="get">
        <label>
          Game
          <input name="game" defaultValue={query.game ?? ""} />
        </label>
        <label>
          Language
          <input name="language" defaultValue={query.language ?? ""} />
        </label>
        <label>
          Set
          <input name="set" defaultValue={query.set ?? ""} />
        </label>
        <button type="submit">Filter</button>
      </form>
      {printings.length === 0 ? (
        <EmptyState title="No printings" body="Identity fixtures or ingest populate the catalog." />
      ) : (
        <ul>
          {printings.map((row) => (
            <li key={row.printingId}>
              <Link href={`/app/cards/${row.printingId}`}>
                <IdentityLine identity={row} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
