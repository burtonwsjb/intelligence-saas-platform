import {
  EXPLORER_DEFAULT_CURRENCY,
  EXPLORER_MARKET_SENTIMENTS,
  EXPLORER_PRICE_PRESETS,
  EXPLORER_RECOMMENDATIONS,
  EXPLORER_SOCIAL_SENTIMENTS,
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
  market_buy: "Best investment (strongest buy)",
  market_sell: "Market: strongest sell",
  social_positive: "Social: most positive",
  social_negative: "Social: most negative",
  social_posts: "Social: most talked about",
};

const MARKET_TEXT: Record<(typeof EXPLORER_MARKET_SENTIMENTS)[number], string> = {
  buy: "Buy or strong buy",
  hold: "Hold or watch",
  sell: "Sell, reduce or strong sell",
  none: "No reading yet",
};

const SOCIAL_TEXT: Record<(typeof EXPLORER_SOCIAL_SENTIMENTS)[number], string> = {
  positive: "Leaning positive",
  negative: "Leaning negative",
  neutral: "Neutral or split",
  any: "Any posts",
  none: "No posts",
};

const WINDOW_TEXT = { "7d": "7 days", "30d": "30 days", "90d": "90 days" } as const;

/** One-click lists for the questions collectors ask most. */
const QUICK_PICKS: { label: string; overrides: Partial<ExplorerQuery> }[] = [
  {
    label: "Best buys $100–$200",
    overrides: { view: "all", market: "buy", sort: "market_buy", minPrice: 100, maxPrice: 200, priceCurrency: EXPLORER_DEFAULT_CURRENCY },
  },
  { label: "Chase cards, highest price", overrides: { view: "chase", sort: "price_high" } },
  { label: "Best chase buys", overrides: { view: "chase", market: "buy", sort: "market_buy" } },
  { label: "Most talked-about buys", overrides: { view: "talked", market: "buy", sort: "social_posts" } },
];

function sameRange(query: ExplorerQuery, min?: number, max?: number): boolean {
  return query.minPrice === min && query.maxPrice === max && (query.minPrice != null || query.maxPrice != null);
}

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
            href={`${basePath}${explorerQueryToSearch(query, {
              view,
              page: 1,
              // "Most talked about" means most posts first unless another sort was picked.
              ...(view === "talked" && query.sort === "opportunity" ? { sort: "social_posts" as const } : {}),
            })}`}
            aria-current={query.view === view ? "page" : undefined}
            title={EXPLORER_VIEW_DEFINITIONS[view].description}
          >
            {EXPLORER_VIEW_DEFINITIONS[view].label}
          </Link>
        ))}
      </nav>
      <div className="quick-picks" aria-label="Quick picks">
        <span className="quick-picks-label">Popular</span>
        {QUICK_PICKS.map((pick) => (
          <Link
            key={pick.label}
            className="pill-link"
            href={`${basePath}${explorerQueryToSearch({ ...query, ...CLEARED, ...pick.overrides })}`}
          >
            {pick.label}
          </Link>
        ))}
      </div>
      <form method="get" action={basePath} role="search" aria-label="Filter cards">
        <input type="hidden" name="view" value={query.view} />
        <input type="hidden" name="mode" value={query.mode} />
        <input type="hidden" name="pageSize" value={query.pageSize} />
        <div className="quick-picks" aria-label="Price range">
          <span className="quick-picks-label">Price</span>
          {EXPLORER_PRICE_PRESETS.map((preset) => {
            const active = sameRange(query, preset.min, preset.max) && query.priceCurrency === EXPLORER_DEFAULT_CURRENCY;
            return (
              <Link
                key={preset.label}
                className="pill-link"
                aria-pressed={active}
                href={`${basePath}${explorerQueryToSearch(query, {
                  minPrice: active ? undefined : preset.min,
                  maxPrice: active ? undefined : preset.max,
                  priceCurrency: active ? undefined : EXPLORER_DEFAULT_CURRENCY,
                  page: 1,
                })}`}
              >
                {preset.label}
              </Link>
            );
          })}
          <span className="price-inputs">
            <label>
              <span className="visually-hidden">Min price in dollars</span>
              <input name="minPrice" type="number" min={0} step="0.01" inputMode="decimal" placeholder="Min $" defaultValue={query.minPrice ?? ""} />
            </label>
            <span aria-hidden="true">to</span>
            <label>
              <span className="visually-hidden">Max price in dollars</span>
              <input name="maxPrice" type="number" min={0} step="0.01" inputMode="decimal" placeholder="Max $" defaultValue={query.maxPrice ?? ""} />
            </label>
          </span>
          {query.minPrice != null || query.maxPrice != null ? (
            <Link
              className="text-link"
              href={`${basePath}${explorerQueryToSearch(query, { minPrice: undefined, maxPrice: undefined, priceCurrency: undefined, page: 1 })}`}
            >
              Any price
            </Link>
          ) : null}
        </div>
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
            Market sentiment
            <select name="market" defaultValue={query.market ?? ""}>
              <option value="">Any</option>
              {EXPLORER_MARKET_SENTIMENTS.map((value) => (
                <option key={value} value={value}>
                  {MARKET_TEXT[value]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Social sentiment
            <select name="social" defaultValue={query.social ?? ""}>
              <option value="">Any</option>
              {EXPLORER_SOCIAL_SENTIMENTS.map((value) => (
                <option key={value} value={value}>
                  {SOCIAL_TEXT[value]}
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
            {facets.currencies.some((currency) => currency !== EXPLORER_DEFAULT_CURRENCY) ? (
              <label className="field">
                Price currency
                <select name="priceCurrency" defaultValue={query.priceCurrency ?? ""}>
                  <option value="">US dollars (default)</option>
                  {facets.currencies
                    .filter((currency) => currency !== EXPLORER_DEFAULT_CURRENCY)
                    .map((currency) => (
                      <option key={currency} value={currency}>
                        {currency}
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
          </div>
          <p className="subtle" style={{ margin: 0 }}>
            Price ranges use US dollars (TCGplayer market price) unless another currency is chosen. Cards from sets that are
            not out yet are left out of price ranges, since presale prices are not a real market.{" "}
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
  market: undefined,
  social: undefined,
  minOpportunity: undefined,
  maxRisk: undefined,
  minConfidence: undefined,
  minLiquidity: undefined,
  priceCurrency: undefined,
  minPrice: undefined,
  maxPrice: undefined,
  page: 1,
};
