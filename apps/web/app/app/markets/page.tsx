import { EmptyState } from "@/components/EmptyState";
import { IdentityLine } from "@/components/IdentityLine";
import { loadAppAccess } from "@/lib/app-access";
import { getDb } from "@/lib/auth";
import { listPrintingCatalog, listTcgGames, tcgSet } from "@isp/db";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function MarketsPage({
  searchParams,
}: {
  searchParams: Promise<{ game?: string; language?: string }>;
}) {
  await loadAppAccess();
  const query = await searchParams;
  const [games, sets, printings] = await Promise.all([
    listTcgGames(getDb()),
    getDb().select().from(tcgSet),
    listPrintingCatalog(getDb(), { game: query.game || undefined, language: query.language || undefined }),
  ]);

  return (
    <>
      <h1>Markets</h1>
      <p className="muted">Browse games, sets, and exact printings. Language and variant are never hidden.</p>
      <form className="filter-form" method="get">
        <label>
          Game
          <input name="game" defaultValue={query.game ?? ""} />
        </label>
        <label>
          Language
          <input name="language" defaultValue={query.language ?? ""} />
        </label>
        <button type="submit">Filter</button>
      </form>
      <h2>Games</h2>
      {games.length === 0 ? (
        <EmptyState title="No games" body="Seed TCG identity fixtures locally to populate the catalog." />
      ) : (
        <ul>
          {games.map((game) => (
            <li key={game.gameKey}>{game.gameKey}</li>
          ))}
        </ul>
      )}
      <h2>Sets</h2>
      <ul>
        {sets.map((set) => (
          <li key={set.id}>
            {set.name} · {set.canonicalSetKey} · {set.gameKey}
            {set.languageScope ? ` · ${set.languageScope}` : ""}
          </li>
        ))}
      </ul>
      <h2>Printings</h2>
      {printings.length === 0 ? (
        <p className="muted">No printings match.</p>
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
