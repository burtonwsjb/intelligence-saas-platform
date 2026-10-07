import {
  EXPLORER_RECOMMENDATIONS,
  EXPLORER_SORTS,
  EXPLORER_VIEW_DEFINITIONS,
  EXPLORER_VIEWS,
  EXPLORER_WINDOWS,
  countAdvancedFilters,
  explorerQueryToSearch,
  type ExplorerFacets,
  type ExplorerQuery,
} from "@isp/db";
import { languageText, recommendationText, variantText } from "@/lib/display";
import Link from "next/link";

const SORT_TEXT: Record<(typeof EXPLORER_SORTS)[number], string> = {
  opportunity: "Highest opportunity",
  risk_low: "Lowest risk",
  confidence: "Highest confidence",
  liquidity: "Most liquid",
  price_high: "Price: high to low",
  price_low: "Price: low to high",
  name: "Name A–Z",
  recent: "Recently scored",
};

const WINDOW_TEXT = { "7d": "7 days", "30d": "30 days", "90d": "90 days" } as const;

/**
 * GET form: every filter, sort, window and view lives in the URL, so a link,
 * a refresh or the back button restores the same list. Preset and mode
 * switches are plain links that keep the rest of the state.
 */
export function FilterBar({ query, facets, basePath }: { query: ExplorerQuery; facets: ExplorerFacets; basePath: string }) {
  const advanced = countAdvancedFilters(query);
  return (
    <div className="filter-bar">
      <nav className="segmented" aria-label="Card views">
        {EXPLORER_VIEWS.map((view) => (
          <Link
            key={view}
            href={`${basePath}${explorerQueryToSearch(query, { view, page: 1 })}`}
            aria-current={query.view === view ? "page" : undefined}
            title={EXPLORER_VIEW_DEFINITIONS[view].description}
          >
            {EXPLORER_VIEW_DEFINITIONS[view].label}
          </Link>
        ))}
      </nav>
      <form method="get" action={basePath} role="search" aria-label="Filter cards">
        <input type="hidden" name="view" value={query.view} />
        <input type="hidden" name="mode" value={query.mode} />
        <input type="hidden" name="pageSize" value={query.pageSize} />
        <div className="filter-row">
          <label className="field grow">
            Search
            <input
              type="search"
              name="q"
              defaultValue={query.q ?? ""}
              placeholder="Card, set, collector number or ID"
              maxLength={80}
            />
          </label>
          <label className="field">
            Language
            <select name="language" defaultValue={query.language ?? ""}>
              <option value="">All languages</option>
              {facets.languages.map((language) => (
                <option key={language.key} value={language.key}>
                  {language.label || languageText(language.key)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Set
            <select name="set" defaultValue={query.set ?? ""}>
              <option value="">All sets</option>
              {facets.sets.map((set) => (
                <option key={set.key} value={set.key}>
                  {set.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Sort
            <select name="sort" defaultValue={query.sort}>
              {EXPLORER_SORTS.map((sort) => (
                <option key={sort} value={sort}>
                  {SORT_TEXT[sort]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Price window
            <select name="window" defaultValue={query.window}>
              {EXPLORER_WINDOWS.map((window) => (
                <option key={window} value={window}>
                  {WINDOW_TEXT[window]}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="button">
            Apply
          </button>
        </div>
        <details className="filter-advanced" open={advanced > 0}>
          <summary>More filters{advanced > 0 ? ` (${advanced} on)` : ""}</summary>
          <div className="filter-row">
            {facets.games.length > 1 ? (
              <label className="field">
                Game
                <select name="game" defaultValue={query.game ?? ""}>
                  <option value="">All games</option>
                  {facets.games.map((game) => (
                    <option key={game.key} value={game.key}>
                      {game.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : query.game ? (
              <input type="hidden" name="game" value={query.game} />
            ) : null}
            <label className="field">
              Printing
              <select name="variant" defaultValue={query.variant ?? ""}>
                <option value="">Any printing</option>
                {facets.variants.map((variant) => (
                  <option key={variant} value={variant}>
                    {variantText(variant)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Recommendation
              <select name="recommendation" defaultValue={query.recommendation ?? ""}>
                <option value="">Any</option>
                {EXPLORER_RECOMMENDATIONS.map((value) => (
                  <option key={value} value={value}>
                    {recommendationText(value)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Min opportunity
              <input name="minOpportunity" type="number" min={0} max={100} inputMode="numeric" defaultValue={query.minOpportunity ?? ""} />
            </label>
            <label className="field">
              Max risk
              <input name="maxRisk" type="number" min={0} max={100} inputMode="numeric" defaultValue={query.maxRisk ?? ""} />
            </label>
            <label className="field">
              Min confidence
              <input name="minConfidence" type="number" min={0} max={100} inputMode="numeric" defaultValue={query.minConfidence ?? ""} />
            </label>
            <label className="field">
              Min liquidity
              <input name="minLiquidity" type="number" min={0} max={100} inputMode="numeric" defaultValue={query.minLiquidity ?? ""} />
            </label>
            <label className="field">
              Price currency
              <select name="priceCurrency" defaultValue={query.priceCurrency ?? ""}>
                <option value="">Choose to filter by price</option>
                {facets.currencies.map((currency) => (
                  <option key={currency} value={currency}>
                    {currency}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Min price
              <input name="minPrice" type="number" min={0} step="0.01" inputMode="decimal" defaultValue={query.minPrice ?? ""} />
            </label>
            <label className="field">
              Max price
              <input name="maxPrice" type="number" min={0} step="0.01" inputMode="decimal" defaultValue={query.maxPrice ?? ""} />
            </label>
          </div>
          <p className="subtle" style={{ margin: 0 }}>
            Price bounds apply only within the chosen currency, so prices are never compared across currencies.{" "}
            <Link className="text-link" href={`${basePath}${explorerQueryToSearch({ ...query, ...CLEARED })}`}>
              Clear filters
            </Link>
          </p>
        </details>
      </form>
    </div>
  );
}

const CLEARED: Partial<ExplorerQuery> = {
  q: undefined,
  game: undefined,
  set: undefined,
  language: undefined,
  variant: undefined,
  recommendation: undefined,
  minOpportunity: undefined,
  maxRisk: undefined,
  minConfidence: undefined,
  minLiquidity: undefined,
  priceCurrency: undefined,
  minPrice: undefined,
  maxPrice: undefined,
  page: 1,
};
