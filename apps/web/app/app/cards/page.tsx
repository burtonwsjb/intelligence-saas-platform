import { CardTile } from "@/components/CardTile";
import { EmptyState, LockedFeature } from "@/components/EmptyState";
import { FilterBar } from "@/components/FilterBar";
import { ResultPager } from "@/components/ResultPager";
import { ANALYTICS_LOCKED_BODY, loadAppAccess, loadHiddenCreatorIds } from "@/lib/app-access";
import { getDb } from "@/lib/auth";
import { formatChange, formatScore, languageText, recommendationText, variantText } from "@/lib/display";
import {
  EXPLORER_PAGE_SIZES,
  EXPLORER_VIEW_DEFINITIONS,
  SENTIMENT_LABEL_TEXT,
  explorerQueryToSearch,
  listCardExplorerPage,
  listExplorerFacets,
  parseExplorerQuery,
} from "@isp/db";
import { formatMoney } from "@isp/shared";
import Link from "next/link";

export const dynamic = "force-dynamic";

const BASE = "/app/cards";

export default async function CardsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { access, organizationId, userId } = await loadAppAccess();
  if (!access.canViewAnalytics) {
    return <LockedFeature title="Cards" body={ANALYTICS_LOCKED_BODY} />;
  }
  const query = parseExplorerQuery(await searchParams);
  const [result, facets] = await Promise.all([
    loadHiddenCreatorIds(organizationId, userId).then((hiddenCreatorIds) =>
      listCardExplorerPage(getDb(), query, { hiddenCreatorIds }),
    ),
    listExplorerFacets(getDb(), { game: query.game }),
  ]);
  const search = explorerQueryToSearch(query);
  // Detail links carry the list state so "Back to cards" restores the same page.
  const detailHref = (printingId: string) =>
    `${BASE}/${encodeURIComponent(printingId)}${search ? `?from=${encodeURIComponent(search)}` : ""}`;
  const windowLabel = query.window;
  const view = EXPLORER_VIEW_DEFINITIONS[query.view];

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Cards</p>
          <h1>{view.label}</h1>
          <p className="muted">{view.description}</p>
        </div>
        <nav className="segmented" aria-label="Layout">
          <Link href={`${BASE}${explorerQueryToSearch(query, { mode: "grid" })}`} aria-pressed={query.mode === "grid"}>
            Gallery
          </Link>
          <Link href={`${BASE}${explorerQueryToSearch(query, { mode: "table" })}`} aria-pressed={query.mode === "table"}>
            Table
          </Link>
        </nav>
      </header>
      <FilterBar query={query} facets={facets} basePath={BASE} />
      {result.rows.length === 0 ? (
        <EmptyState
          title={result.total > 0 ? "This page is past the end of the results" : "No cards match these filters"}
          body={
            result.total > 0
              ? `There are ${result.total} matching cards on earlier pages.`
              : query.view === "all"
                ? "Try a broader search or clear a filter. Cards appear here as the catalog and market data grow."
                : "No card currently meets this view's definition. Try All cards to browse the full catalog."
          }
          action={
            <Link className="text-link" href={`${BASE}${explorerQueryToSearch(query, { page: 1, view: result.total > 0 ? query.view : "all" })}`}>
              {result.total > 0 ? "Go to the first page" : "Show all cards"}
            </Link>
          }
        />
      ) : query.mode === "table" ? (
        <div className="table-wrap">
          <table className="data-table">
            <caption className="visually-hidden">Cards, {view.label}</caption>
            <thead>
              <tr>
                <th scope="col">Printing</th>
                <th scope="col">Language · printing</th>
                <th scope="col" className="num">Last sold</th>
                <th scope="col" className="num">{windowLabel} change</th>
                <th scope="col" className="num">Opportunity</th>
                <th scope="col" className="num">Risk</th>
                <th scope="col" className="num">Confidence</th>
                <th scope="col" className="num">Liquidity</th>
                <th scope="col">Recommendation</th>
                <th scope="col">Social</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row) => (
                <tr key={row.printingId}>
                  <td>
                    <Link href={detailHref(row.printingId)} className="identity-line">
                      {row.cardName}
                    </Link>
                    <div className="subtle">
                      {row.setName} · #{row.collectorNumber}
                    </div>
                  </td>
                  <td>
                    {languageText(row.languageCode)} · {variantText(row.variantKey)}
                  </td>
                  <td className="num">
                    {row.price ? `${formatMoney(row.price.amount, row.price.currency)} ${row.price.currency}` : "—"}
                  </td>
                  <td className="num">{formatChange(row.windowChange)?.text ?? "—"}</td>
                  <td className="num">{formatScore(row.score?.opportunity)}</td>
                  <td className="num">{formatScore(row.score?.risk)}</td>
                  <td className="num">{formatScore(row.score?.confidence)}</td>
                  <td className="num">{formatScore(row.score?.liquidity)}</td>
                  <td>{row.score ? recommendationText(row.score.recommendation) : "Not scored"}</td>
                  <td>{SENTIMENT_LABEL_TEXT[row.sentiment.label]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul className="card-grid">
          {result.rows.map((row) => (
            <li key={row.printingId}>
              <CardTile row={row} href={detailHref(row.printingId)} windowLabel={windowLabel} />
            </li>
          ))}
        </ul>
      )}
      <ResultPager
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
        pageSize={result.pageSize}
        noun="cards"
        hrefFor={(page) => `${BASE}${explorerQueryToSearch(query, { page })}`}
        sizes={EXPLORER_PAGE_SIZES}
        hrefForSize={(pageSize) => `${BASE}${explorerQueryToSearch(query, { pageSize, page: 1 })}`}
      />
      <p className="subtle">
        Scores are versioned outputs of the scoring pipeline on a 0–100 scale. They are not probabilities and are not
        investment advice. Prices are the latest valid ungraded sale; outliers are kept as evidence but excluded here.
      </p>
    </>
  );
}
