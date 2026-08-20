import { EmptyState } from "@/components/EmptyState";
import { IdentityLine } from "@/components/IdentityLine";
import { loadAppAccess } from "@/lib/app-access";
import { getDb } from "@/lib/auth";
import { listLatestOpportunities, listTcgGames, listTcgLanguages } from "@isp/db";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<{
    game?: string;
    language?: string;
    set?: string;
    recommendation?: string;
    minOpportunity?: string;
    maxRisk?: string;
    minLiquidity?: string;
  }>;
}) {
  await loadAppAccess();
  const query = await searchParams;
  const [games, languages, rows] = await Promise.all([
    listTcgGames(getDb()),
    listTcgLanguages(getDb()),
    listLatestOpportunities(getDb(), {
      game: query.game || undefined,
      language: query.language || undefined,
      set: query.set || undefined,
      recommendation: query.recommendation || undefined,
      minOpportunity: query.minOpportunity ? Number(query.minOpportunity) : undefined,
      maxRisk: query.maxRisk ? Number(query.maxRisk) : undefined,
      minLiquidity: query.minLiquidity ? Number(query.minLiquidity) : undefined,
    }),
  ]);

  return (
    <>
      <h1>Opportunities</h1>
      <p className="muted">
        Opportunity, risk, confidence, and liquidity are separate scores. Language and variant are part of identity.
      </p>
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
        <label>
          Recommendation
          <input name="recommendation" defaultValue={query.recommendation ?? ""} />
        </label>
        <label>
          Min opportunity
          <input name="minOpportunity" defaultValue={query.minOpportunity ?? ""} />
        </label>
        <label>
          Max risk
          <input name="maxRisk" defaultValue={query.maxRisk ?? ""} />
        </label>
        <label>
          Min liquidity
          <input name="minLiquidity" defaultValue={query.minLiquidity ?? ""} />
        </label>
        <button type="submit">Filter</button>
      </form>
      <p className="muted">
        Catalog games: {games.map((game) => game.gameKey).join(", ") || "none"} · languages:{" "}
        {languages.map((language) => language.languageCode).join(", ") || "none"}
      </p>
      {rows.length === 0 ? (
        <EmptyState title="No opportunities match" body="Ingest and score printings locally to populate this list." />
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Printing</th>
              <th>Price</th>
              <th>Opportunity</th>
              <th>Risk</th>
              <th>Confidence</th>
              <th>Liquidity</th>
              <th>Recommendation</th>
              <th>As of</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.score.id}>
                <td>
                  <Link href={`/app/opportunities/${row.identity.printingId}`}>
                    <IdentityLine identity={row.identity} />
                  </Link>
                </td>
                <td>
                  {row.market?.price ?? "—"} {row.market?.currency ?? ""}
                </td>
                <td>{Number(row.score.opportunityScore).toFixed(1)}</td>
                <td>{Number(row.score.riskScore).toFixed(1)}</td>
                <td>{Number(row.score.confidenceScore).toFixed(1)}</td>
                <td>{Number(row.score.liquidityScore).toFixed(1)}</td>
                <td>{row.score.recommendation}</td>
                <td>{row.score.asOf.toISOString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
