import { sql, type SQL } from "drizzle-orm";
import type { Database } from "../client.js";

// Card explorer read model. Every number returned here comes from persisted,
// versioned records (score snapshots, market snapshots, resolved mentions).
// Nothing is computed into a competing score: the explorer only selects,
// filters, pages, and summarizes what the canonical pipeline already wrote.

export const EXPLORER_PAGE_SIZES = [12, 24, 48] as const;
export const EXPLORER_DEFAULT_PAGE_SIZE = 24;
export const EXPLORER_MAX_PAGE_SIZE = 48;
export const EXPLORER_MAX_PAGE = 500;

export const EXPLORER_VIEWS = ["all", "opportunities", "confirmed", "social", "caution"] as const;
export type ExplorerView = (typeof EXPLORER_VIEWS)[number];

export const EXPLORER_SORTS = [
  "opportunity",
  "risk_low",
  "confidence",
  "liquidity",
  "price_high",
  "price_low",
  "name",
  "recent",
] as const;
export type ExplorerSort = (typeof EXPLORER_SORTS)[number];

export const EXPLORER_WINDOWS = ["7d", "30d", "90d"] as const;
export type ExplorerWindow = (typeof EXPLORER_WINDOWS)[number];
export const EXPLORER_WINDOW_DAYS: Record<ExplorerWindow, number> = { "7d": 7, "30d": 30, "90d": 90 };

export const EXPLORER_MODES = ["grid", "table"] as const;
export type ExplorerMode = (typeof EXPLORER_MODES)[number];

export const EXPLORER_RECOMMENDATIONS = [
  "strong_buy",
  "buy",
  "watch",
  "hold",
  "reduce",
  "sell",
  "strong_sell",
  "insufficient_data",
] as const;

// Predicates behind each curated view. Kept as data so the UI can explain
// exactly what a preset means instead of implying more than it filters.
export const EXPLORER_VIEW_DEFINITIONS: Record<ExplorerView, { label: string; description: string }> = {
  all: { label: "All cards", description: "Every active exact printing, scored or not." },
  opportunities: {
    label: "Opportunities",
    description: "Opportunity score 60 or higher with enough evidence to score.",
  },
  confirmed: {
    label: "Market-confirmed",
    description: "The latest score saw enough recent sales to confirm market activity.",
  },
  social: {
    label: "Social attention",
    description: "Resolved social activity contributed to the latest score. Attention is not confirmation.",
  },
  caution: {
    label: "Caution",
    description: "Risk 60 or higher, social activity without sales confirmation, or stale/outlier-dependent data.",
  },
};

export type ExplorerQuery = {
  q?: string;
  game?: string;
  set?: string;
  language?: string;
  variant?: string;
  recommendation?: string;
  minOpportunity?: number;
  maxRisk?: number;
  minConfidence?: number;
  minLiquidity?: number;
  priceCurrency?: string;
  minPrice?: number;
  maxPrice?: number;
  view: ExplorerView;
  sort: ExplorerSort;
  window: ExplorerWindow;
  mode: ExplorerMode;
  page: number;
  pageSize: number;
};

export const EXPLORER_DEFAULTS: Pick<ExplorerQuery, "view" | "sort" | "window" | "mode" | "page" | "pageSize"> = {
  view: "all",
  sort: "opportunity",
  window: "30d",
  mode: "grid",
  page: 1,
  pageSize: EXPLORER_DEFAULT_PAGE_SIZE,
};

type RawParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function token(value: string | string[] | undefined, max = 64): string | undefined {
  const raw = first(value);
  if (!raw || raw.length > max || !/^[A-Za-z0-9_.:-]+$/.test(raw)) return undefined;
  return raw;
}

function bounded(value: string | string[] | undefined, min: number, max: number): number | undefined {
  const raw = first(value);
  if (raw == null || !/^-?\d+(\.\d+)?$/.test(raw)) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  return n;
}

function oneOf<T extends string>(value: string | string[] | undefined, allowed: readonly T[], fallback: T): T {
  const raw = first(value);
  return raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/** Validates URL search params into a bounded explorer query. Invalid values are dropped, never guessed. */
export function parseExplorerQuery(raw: RawParams): ExplorerQuery {
  const q = first(raw.q);
  const pageSizeRaw = bounded(raw.pageSize, 1, 1000);
  const pageSize =
    pageSizeRaw != null && (EXPLORER_PAGE_SIZES as readonly number[]).includes(pageSizeRaw)
      ? pageSizeRaw
      : EXPLORER_DEFAULT_PAGE_SIZE;
  const page = Math.trunc(bounded(raw.page, 1, EXPLORER_MAX_PAGE) ?? 1);
  const priceCurrency = token(raw.priceCurrency, 3)?.toUpperCase();
  const currencyOk = priceCurrency != null && /^[A-Z]{3}$/.test(priceCurrency);
  const recommendation = first(raw.recommendation);
  return {
    q: q ? q.slice(0, 80) : undefined,
    game: token(raw.game),
    set: token(raw.set, 128),
    language: token(raw.language, 16),
    variant: token(raw.variant),
    recommendation:
      recommendation && (EXPLORER_RECOMMENDATIONS as readonly string[]).includes(recommendation)
        ? recommendation
        : undefined,
    minOpportunity: bounded(raw.minOpportunity, 0, 100),
    maxRisk: bounded(raw.maxRisk, 0, 100),
    minConfidence: bounded(raw.minConfidence, 0, 100),
    minLiquidity: bounded(raw.minLiquidity, 0, 100),
    // A price bound without an explicit currency would silently mix currencies.
    priceCurrency: currencyOk ? priceCurrency : undefined,
    minPrice: currencyOk ? bounded(raw.minPrice, 0, 1e9) : undefined,
    maxPrice: currencyOk ? bounded(raw.maxPrice, 0, 1e9) : undefined,
    view: oneOf(raw.view, EXPLORER_VIEWS, EXPLORER_DEFAULTS.view),
    sort: oneOf(raw.sort, EXPLORER_SORTS, EXPLORER_DEFAULTS.sort),
    window: oneOf(raw.window, EXPLORER_WINDOWS, EXPLORER_DEFAULTS.window),
    mode: oneOf(raw.mode, EXPLORER_MODES, EXPLORER_DEFAULTS.mode),
    page,
    pageSize,
  };
}

/** Serializes a query back to URL params, omitting defaults so links stay short and stable. */
export function explorerQueryToSearch(query: ExplorerQuery, overrides: Partial<ExplorerQuery> = {}): string {
  const merged: ExplorerQuery = { ...query, ...overrides };
  const params = new URLSearchParams();
  const keys: (keyof ExplorerQuery)[] = [
    "q",
    "view",
    "game",
    "set",
    "language",
    "variant",
    "recommendation",
    "minOpportunity",
    "maxRisk",
    "minConfidence",
    "minLiquidity",
    "priceCurrency",
    "minPrice",
    "maxPrice",
    "sort",
    "window",
    "mode",
    "pageSize",
    "page",
  ];
  for (const key of keys) {
    const value = merged[key];
    if (value == null) continue;
    if (key in EXPLORER_DEFAULTS && EXPLORER_DEFAULTS[key as keyof typeof EXPLORER_DEFAULTS] === value) continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function countAdvancedFilters(query: ExplorerQuery): number {
  return [
    query.variant,
    query.recommendation,
    query.minOpportunity,
    query.maxRisk,
    query.minConfidence,
    query.minLiquidity,
    query.minPrice,
    query.maxPrice,
  ].filter((value) => value != null).length;
}

export type ExplorerScore = {
  asOf: Date;
  scoreVersion: string;
  opportunity: number;
  risk: number;
  confidence: number;
  liquidity: number;
  recommendation: string;
  dataQuality: string;
  marketConfirmed: boolean | null;
  hypeUnconfirmed: boolean;
  why: string | null;
};

export type ExplorerPrice = {
  amount: string;
  currency: string;
  condition: string;
  sourceKey: string;
  observedAt: Date;
  quoteType: "sold";
};

export type ExplorerSeriesPoint = { observedAt: Date; amount: number };

export type ExplorerRow = {
  printingId: string;
  gameKey: string;
  cardName: string;
  setName: string;
  setKey: string;
  collectorNumber: string;
  languageCode: string;
  variantKey: string;
  rarity: string | null;
  finish: string | null;
  canonicalPrintingKey: string;
  score: ExplorerScore | null;
  price: ExplorerPrice | null;
  series: ExplorerSeriesPoint[];
  windowChange: number | null;
  sentiment: SentimentSummary;
};

export type ExplorerPage = {
  rows: ExplorerRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  window: { key: ExplorerWindow; from: Date; to: Date };
};

function asRows(result: unknown): Record<string, unknown>[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function toNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asBool(value: unknown): boolean | null {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

// Raw SQL params go through the driver untyped; pass instants as ISO text with
// an explicit cast so postgres-js and PGlite bind them identically.
function ts(value: Date): SQL {
  return sql`${value.toISOString()}::timestamptz`;
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function inList(ids: string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

function viewPredicate(view: ExplorerView): SQL {
  switch (view) {
    case "opportunities":
      return sql`s.opportunity_score >= 60 AND s.data_quality <> 'insufficient_data'`;
    case "confirmed":
      return sql`(s.components ->> 'market_confirmed') = 'true'`;
    case "social":
      return sql`(s.components -> 'social' ->> 'present') = 'true'`;
    case "caution":
      return sql`(s.risk_score >= 60 OR (s.components ->> 'hype_unconfirmed') = 'true' OR s.data_quality IN ('stale', 'outlier_dependent'))`;
    default:
      return sql`TRUE`;
  }
}

function orderBy(sort: ExplorerSort): SQL {
  switch (sort) {
    case "risk_low":
      return sql`s.risk_score ASC NULLS LAST, s.opportunity_score DESC NULLS LAST`;
    case "confidence":
      return sql`s.confidence_score DESC NULLS LAST`;
    case "liquidity":
      return sql`s.liquidity_score DESC NULLS LAST`;
    case "price_high":
      return sql`m.price DESC NULLS LAST`;
    case "price_low":
      return sql`m.price ASC NULLS LAST`;
    case "name":
      return sql`c.canonical_name ASC, st.name ASC, p.collector_number_normalized ASC`;
    case "recent":
      return sql`s.as_of DESC NULLS LAST`;
    default:
      return sql`s.opportunity_score DESC NULLS LAST, s.confidence_score DESC NULLS LAST`;
  }
}

function filterClauses(query: ExplorerQuery): SQL[] {
  const clauses: SQL[] = [sql`p.status = 'active'`, viewPredicate(query.view)];
  if (query.game) clauses.push(sql`p.game_key = ${query.game}`);
  if (query.language) clauses.push(sql`p.language_code = ${query.language}`);
  if (query.set) clauses.push(sql`st.canonical_set_key = ${query.set}`);
  if (query.variant) clauses.push(sql`p.variant_key = ${query.variant}`);
  if (query.recommendation) clauses.push(sql`s.recommendation = ${query.recommendation}`);
  if (query.minOpportunity != null) clauses.push(sql`s.opportunity_score >= ${query.minOpportunity}`);
  if (query.maxRisk != null) clauses.push(sql`s.risk_score <= ${query.maxRisk}`);
  if (query.minConfidence != null) clauses.push(sql`s.confidence_score >= ${query.minConfidence}`);
  if (query.minLiquidity != null) clauses.push(sql`s.liquidity_score >= ${query.minLiquidity}`);
  if (query.priceCurrency && (query.minPrice != null || query.maxPrice != null)) {
    clauses.push(sql`m.currency = ${query.priceCurrency}`);
    if (query.minPrice != null) clauses.push(sql`m.price >= ${query.minPrice}`);
    if (query.maxPrice != null) clauses.push(sql`m.price <= ${query.maxPrice}`);
  }
  if (query.q) {
    const pattern = likePattern(query.q);
    const exact = query.q.toLowerCase();
    clauses.push(sql`(
      c.canonical_name ILIKE ${pattern}
      OR st.name ILIKE ${pattern}
      OR st.canonical_set_key ILIKE ${pattern}
      OR p.collector_number ILIKE ${pattern}
      OR p.canonical_printing_key ILIKE ${pattern}
      OR EXISTS (
        SELECT 1 FROM tcg_printing_identifier i
        WHERE i.printing_id = p.id AND i.normalized_value = ${exact}
      )
    )`);
  }
  return clauses;
}

/**
 * One bounded page of exact printings with their latest persisted score and
 * latest valid sold price. Filtering, sorting and paging run in SQL so the
 * response size is fixed by pageSize, not by catalog size.
 */
export async function listCardExplorerPage(
  db: Database,
  query: ExplorerQuery,
  options: { now?: Date } = {},
): Promise<ExplorerPage> {
  const pageSize = Math.min(Math.max(1, query.pageSize), EXPLORER_MAX_PAGE_SIZE);
  const page = Math.min(Math.max(1, Math.trunc(query.page)), EXPLORER_MAX_PAGE);
  const now = options.now ?? new Date();
  const from = new Date(now.getTime() - EXPLORER_WINDOW_DAYS[query.window] * 86_400_000);
  const where = sql.join(filterClauses(query), sql` AND `);
  const result = await db.execute(sql`
    SELECT
      p.id AS printing_id, p.game_key, c.canonical_name AS card_name, st.name AS set_name,
      st.canonical_set_key AS set_key, p.collector_number, p.language_code, p.variant_key,
      p.rarity, p.finish, p.canonical_printing_key,
      s.as_of, s.score_version, s.opportunity_score, s.risk_score, s.confidence_score,
      s.liquidity_score, s.recommendation, s.data_quality,
      s.components ->> 'market_confirmed' AS market_confirmed,
      s.components ->> 'hype_unconfirmed' AS hype_unconfirmed,
      s.explanations AS explanations,
      m.price, m.currency, m.condition, m.source_key, m.observed_at,
      count(*) OVER () AS total
    FROM tcg_printing p
    JOIN tcg_card_concept c ON c.id = p.card_id
    JOIN tcg_set st ON st.id = p.set_id
    LEFT JOIN LATERAL (
      SELECT * FROM tcg_score_snapshot ss
      WHERE ss.printing_id = p.id AND ss.as_of <= ${ts(now)}
      ORDER BY ss.as_of DESC, ss.created_at DESC, ss.id DESC
      LIMIT 1
    ) s ON TRUE
    LEFT JOIN LATERAL (
      SELECT ms.price, ms.currency, ms.condition, ms.source_key, ms.observed_at
      FROM tcg_market_snapshot ms
      WHERE ms.printing_id = p.id
        AND ms.price_type = 'sold'
        AND ms.price IS NOT NULL
        AND ms.outlier_flag = FALSE
        AND ms.grading_company IS NULL
        AND ms.observed_at <= ${ts(now)}
      ORDER BY ms.observed_at DESC, ms.id DESC
      LIMIT 1
    ) m ON TRUE
    WHERE ${where}
    ORDER BY ${orderBy(query.sort)}, p.id ASC
    LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
  `);
  const raw = asRows(result);
  let total = raw.length > 0 ? Number(raw[0]!.total) : 0;
  if (raw.length === 0 && page > 1) {
    // Past the end: report the real total so the pager can lead back.
    const counted = asRows(
      await db.execute(sql`
        SELECT count(*) AS total
        FROM tcg_printing p
        JOIN tcg_card_concept c ON c.id = p.card_id
        JOIN tcg_set st ON st.id = p.set_id
        LEFT JOIN LATERAL (
          SELECT * FROM tcg_score_snapshot ss WHERE ss.printing_id = p.id AND ss.as_of <= ${ts(now)}
          ORDER BY ss.as_of DESC, ss.created_at DESC, ss.id DESC LIMIT 1
        ) s ON TRUE
        LEFT JOIN LATERAL (
          SELECT ms.price, ms.currency FROM tcg_market_snapshot ms
          WHERE ms.printing_id = p.id AND ms.price_type = 'sold' AND ms.price IS NOT NULL
            AND ms.outlier_flag = FALSE AND ms.grading_company IS NULL AND ms.observed_at <= ${ts(now)}
          ORDER BY ms.observed_at DESC, ms.id DESC LIMIT 1
        ) m ON TRUE
        WHERE ${where}
      `),
    );
    total = Number(counted[0]?.total ?? 0);
  }
  const ids = raw.map((row) => String(row.printing_id));
  const [seriesByPrinting, sentimentByPrinting] = await Promise.all([
    loadComparableSeries(db, raw, { from, to: now }),
    loadSentimentSummaries(db, ids, { from, to: now }),
  ]);
  const rows: ExplorerRow[] = raw.map((row) => {
    const printingId = String(row.printing_id);
    const series = seriesByPrinting.get(printingId) ?? [];
    return {
      printingId,
      gameKey: String(row.game_key),
      cardName: String(row.card_name),
      setName: String(row.set_name),
      setKey: String(row.set_key),
      collectorNumber: String(row.collector_number),
      languageCode: String(row.language_code),
      variantKey: String(row.variant_key),
      rarity: row.rarity == null ? null : String(row.rarity),
      finish: row.finish == null ? null : String(row.finish),
      canonicalPrintingKey: String(row.canonical_printing_key),
      score:
        row.as_of == null
          ? null
          : {
              asOf: toDate(row.as_of),
              scoreVersion: String(row.score_version),
              opportunity: toNumber(row.opportunity_score) ?? 0,
              risk: toNumber(row.risk_score) ?? 0,
              confidence: toNumber(row.confidence_score) ?? 0,
              liquidity: toNumber(row.liquidity_score) ?? 0,
              recommendation: String(row.recommendation),
              dataQuality: String(row.data_quality),
              marketConfirmed: asBool(row.market_confirmed),
              hypeUnconfirmed: asBool(row.hype_unconfirmed) === true,
              why: primaryDriver(row.explanations),
            },
      price:
        row.price == null
          ? null
          : {
              amount: String(row.price),
              currency: String(row.currency),
              condition: String(row.condition),
              sourceKey: String(row.source_key),
              observedAt: toDate(row.observed_at),
              quoteType: "sold",
            },
      series,
      windowChange: windowChange(series),
      sentiment: sentimentByPrinting.get(printingId) ?? summarizeSentiment([], { from, to: now }),
    };
  });
  return {
    rows,
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    window: { key: query.window, from, to: now },
  };
}

const DRIVER_SKIP = new Set(["recommendation", "liquidity"]);

/** The first evidence-backed driver line from a persisted score explanation list. */
export function primaryDriver(explanations: unknown): string | null {
  const list = typeof explanations === "string" ? safeJson(explanations) : explanations;
  if (!Array.isArray(list)) return null;
  for (const item of list) {
    if (item && typeof item === "object" && "text" in item) {
      const code = "code" in item ? String((item as { code: unknown }).code) : "";
      if (!DRIVER_SKIP.has(code)) {
        return String((item as { text: unknown }).text);
      }
    }
  }
  return null;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Relative change across comparable observations; null unless at least two exist. */
export function windowChange(series: ExplorerSeriesPoint[]): number | null {
  if (series.length < 2) return null;
  const firstPoint = series[0]!.amount;
  const lastPoint = series[series.length - 1]!.amount;
  if (!(firstPoint > 0)) return null;
  return lastPoint / firstPoint - 1;
}

const MAX_SERIES_POINTS = 60;

/**
 * Sold history restricted to observations comparable with the headline price:
 * same currency, same condition, ungraded, not flagged as an outlier.
 */
async function loadComparableSeries(
  db: Database,
  raw: Record<string, unknown>[],
  range: { from: Date; to: Date },
): Promise<Map<string, ExplorerSeriesPoint[]>> {
  const out = new Map<string, ExplorerSeriesPoint[]>();
  const anchors = raw.filter((row) => row.price != null);
  if (anchors.length === 0) return out;
  const anchorIds = anchors.map((row) => String(row.printing_id));
  const result = await db.execute(sql`
    SELECT printing_id, observed_at, price, currency, condition FROM (
      SELECT ms.printing_id, ms.observed_at, ms.price, ms.currency, ms.condition,
        row_number() OVER (PARTITION BY ms.printing_id, ms.currency, ms.condition ORDER BY ms.observed_at DESC, ms.id DESC) AS rn
      FROM tcg_market_snapshot ms
      WHERE ms.printing_id IN (${inList(anchorIds)})
        AND ms.price_type = 'sold'
        AND ms.price IS NOT NULL
        AND ms.outlier_flag = FALSE
        AND ms.grading_company IS NULL
        AND ms.observed_at > ${ts(range.from)}
        AND ms.observed_at <= ${ts(range.to)}
    ) ranked
    WHERE rn <= ${MAX_SERIES_POINTS}
    ORDER BY printing_id, observed_at ASC
  `);
  const anchorById = new Map(anchors.map((row) => [String(row.printing_id), row]));
  for (const row of asRows(result)) {
    const printingId = String(row.printing_id);
    const anchor = anchorById.get(printingId);
    if (!anchor || row.currency !== anchor.currency || row.condition !== anchor.condition) continue;
    const amount = toNumber(row.price);
    if (amount == null) continue;
    const list = out.get(printingId) ?? [];
    list.push({ observedAt: toDate(row.observed_at), amount });
    out.set(printingId, list);
  }
  return out;
}

export const SENTIMENT_KEYS = ["positive", "neutral", "negative", "mixed"] as const;
export type SentimentKey = (typeof SENTIMENT_KEYS)[number];

export type SentimentEvidenceRow = {
  printingId: string;
  contentId: string;
  accountId: string;
  sentiment: string;
};

export type SentimentSummary = {
  counts: Record<SentimentKey, number>;
  unknown: number;
  classified: number;
  contentItems: number;
  uniqueAccounts: number;
  from: Date;
  to: Date;
  basis: "unweighted_content";
  label: SentimentLabel;
};

export type SentimentLabel =
  | "no_evidence"
  | "too_few"
  | "mostly_positive"
  | "mostly_negative"
  | "leaning_positive"
  | "leaning_negative"
  | "mostly_neutral"
  | "divided";

export const SENTIMENT_MIN_SAMPLE = 3;

/**
 * One vote per content item: several mentions of the same printing inside one
 * post or video do not count as independent opinions. Disagreeing mentions in
 * one item collapse to "mixed". Unknown is reported, never folded into neutral.
 */
export function summarizeSentiment(rows: SentimentEvidenceRow[], range: { from: Date; to: Date }): SentimentSummary {
  const byContent = new Map<string, { accountId: string; values: Set<string> }>();
  for (const row of rows) {
    const entry = byContent.get(row.contentId) ?? { accountId: row.accountId, values: new Set<string>() };
    entry.values.add(row.sentiment);
    byContent.set(row.contentId, entry);
  }
  const counts: Record<SentimentKey, number> = { positive: 0, neutral: 0, negative: 0, mixed: 0 };
  let unknown = 0;
  const accounts = new Set<string>();
  for (const entry of byContent.values()) {
    accounts.add(entry.accountId);
    const known = [...entry.values].filter((value) => value !== "unknown");
    if (known.length === 0) {
      unknown += 1;
    } else if (known.length === 1 && (SENTIMENT_KEYS as readonly string[]).includes(known[0]!)) {
      counts[known[0] as SentimentKey] += 1;
    } else {
      counts.mixed += 1;
    }
  }
  const classified = counts.positive + counts.neutral + counts.negative + counts.mixed;
  return {
    counts,
    unknown,
    classified,
    contentItems: byContent.size,
    uniqueAccounts: accounts.size,
    from: range.from,
    to: range.to,
    basis: "unweighted_content",
    label: sentimentLabel(counts, classified),
  };
}

export function sentimentLabel(counts: Record<SentimentKey, number>, classified: number): SentimentLabel {
  if (classified === 0) return "no_evidence";
  if (classified < SENTIMENT_MIN_SAMPLE) return "too_few";
  const share = (key: SentimentKey) => counts[key] / classified;
  if (share("positive") >= 0.6) return "mostly_positive";
  if (share("negative") >= 0.6) return "mostly_negative";
  if (share("neutral") >= 0.6) return "mostly_neutral";
  if (share("positive") >= 0.25 && share("negative") >= 0.25) return "divided";
  if (share("positive") > share("negative")) return "leaning_positive";
  if (share("negative") > share("positive")) return "leaning_negative";
  return "divided";
}

export const SENTIMENT_LABEL_TEXT: Record<SentimentLabel, string> = {
  no_evidence: "No social evidence",
  too_few: "Too few posts to say",
  mostly_positive: "Mostly positive",
  mostly_negative: "Mostly negative",
  leaning_positive: "Leaning positive",
  leaning_negative: "Leaning negative",
  mostly_neutral: "Mostly neutral",
  divided: "Divided",
};

/**
 * Resolved mention evidence for the given printings within the window. Only the
 * latest resolution attempt per mention counts, and only when it bound the
 * printing exactly (exact / high_confidence). Content from accounts linked to an
 * excluded creator is left out.
 */
export async function listSentimentEvidence(
  db: Database,
  printingIds: string[],
  range: { from: Date; to: Date },
): Promise<SentimentEvidenceRow[]> {
  if (printingIds.length === 0) return [];
  const result = await db.execute(sql`
    WITH candidate AS (
      SELECT DISTINCT a.mention_id FROM entity_resolution_attempt a
      WHERE a.chosen_printing_id IN (${inList(printingIds)}) AND a.mention_id IS NOT NULL
    ),
    latest AS (
      SELECT DISTINCT ON (a.mention_id) a.mention_id, a.chosen_printing_id, a.status
      FROM entity_resolution_attempt a
      JOIN candidate ON candidate.mention_id = a.mention_id
      ORDER BY a.mention_id, a.created_at DESC, a.id DESC
    ),
    excluded_account AS (
      SELECT csa.source_account_id FROM creator_source_account csa
      JOIN LATERAL (
        SELECT te.trust_state FROM creator_trust_event te
        WHERE te.creator_id = csa.creator_id
        ORDER BY te.created_at DESC LIMIT 1
      ) trust ON TRUE
      WHERE trust.trust_state = 'excluded'
    )
    SELECT l.chosen_printing_id AS printing_id, sm.content_id, sc.account_id, sm.sentiment
    FROM latest l
    JOIN source_mention sm ON sm.id = l.mention_id
    JOIN source_content sc ON sc.id = sm.content_id
    WHERE l.status IN ('exact', 'high_confidence')
      AND l.chosen_printing_id IN (${inList(printingIds)})
      AND sc.published_at > ${ts(range.from)}
      AND sc.published_at <= ${ts(range.to)}
      AND sc.account_id NOT IN (SELECT source_account_id FROM excluded_account)
    LIMIT 5000
  `);
  return asRows(result).map((row) => ({
    printingId: String(row.printing_id),
    contentId: String(row.content_id),
    accountId: String(row.account_id),
    sentiment: String(row.sentiment),
  }));
}

async function loadSentimentSummaries(
  db: Database,
  ids: string[],
  range: { from: Date; to: Date },
): Promise<Map<string, SentimentSummary>> {
  const evidence = await listSentimentEvidence(db, ids, range);
  const grouped = new Map<string, SentimentEvidenceRow[]>();
  for (const row of evidence) {
    const list = grouped.get(row.printingId) ?? [];
    list.push(row);
    grouped.set(row.printingId, list);
  }
  return new Map(ids.map((id) => [id, summarizeSentiment(grouped.get(id) ?? [], range)]));
}

export async function getCardSentiment(
  db: Database,
  printingId: string,
  window: ExplorerWindow,
  options: { now?: Date } = {},
): Promise<SentimentSummary> {
  const now = options.now ?? new Date();
  const range = { from: new Date(now.getTime() - EXPLORER_WINDOW_DAYS[window] * 86_400_000), to: now };
  return summarizeSentiment(await listSentimentEvidence(db, [printingId], range), range);
}

export type MarketConfirmationState = "confirmed" | "unconfirmed" | "insufficient" | "no_score";

export function marketConfirmationState(
  score: { dataQuality: string; marketConfirmed: boolean | null } | null,
): MarketConfirmationState {
  if (!score) return "no_score";
  if (score.dataQuality === "insufficient_data" || score.marketConfirmed == null) return "insufficient";
  return score.marketConfirmed ? "confirmed" : "unconfirmed";
}

export type ExplorerFacets = {
  games: { key: string; label: string }[];
  languages: { key: string; label: string }[];
  sets: { key: string; label: string }[];
  variants: string[];
  currencies: string[];
};

/** Bounded option lists for the filter bar. */
export async function listExplorerFacets(db: Database, input: { game?: string } = {}): Promise<ExplorerFacets> {
  const [games, languages, sets, variants, currencies] = await Promise.all([
    db.execute(sql`SELECT game_key, display_name FROM tcg_game WHERE status = 'active' ORDER BY display_name LIMIT 50`),
    db.execute(sql`SELECT language_code, display_name FROM tcg_language WHERE status = 'active' ORDER BY required DESC, display_name LIMIT 50`),
    db.execute(sql`
      SELECT canonical_set_key, name FROM tcg_set
      WHERE status = 'active' ${input.game ? sql`AND game_key = ${input.game}` : sql``}
      ORDER BY release_date DESC NULLS LAST, name ASC LIMIT 200
    `),
    db.execute(sql`SELECT DISTINCT variant_key FROM tcg_printing WHERE status = 'active' ORDER BY variant_key LIMIT 50`),
    db.execute(sql`SELECT DISTINCT currency FROM tcg_market_snapshot WHERE price_type = 'sold' ORDER BY currency LIMIT 20`),
  ]);
  return {
    games: asRows(games).map((row) => ({ key: String(row.game_key), label: String(row.display_name) })),
    languages: asRows(languages).map((row) => ({ key: String(row.language_code), label: String(row.display_name) })),
    sets: asRows(sets).map((row) => ({ key: String(row.canonical_set_key), label: String(row.name) })),
    variants: asRows(variants).map((row) => String(row.variant_key)),
    currencies: asRows(currencies).map((row) => String(row.currency)),
  };
}

export type CardEvidenceItem = {
  contentId: string;
  sourceType: string;
  title: string | null;
  canonicalUrl: string;
  publishedAt: Date;
  sentiment: string;
  accountName: string | null;
};

export const EVIDENCE_PAGE_SIZE = 10;

/** Recent source content resolved to this exact printing, newest first, one page at a time. */
export async function listCardEvidence(
  db: Database,
  printingId: string,
  input: { page?: number } = {},
): Promise<{ items: CardEvidenceItem[]; hasMore: boolean; page: number }> {
  const page = Math.min(Math.max(1, Math.trunc(input.page ?? 1)), EXPLORER_MAX_PAGE);
  const result = await db.execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (a.mention_id) a.mention_id, a.chosen_printing_id, a.status
      FROM entity_resolution_attempt a
      WHERE a.mention_id IN (
        SELECT mention_id FROM entity_resolution_attempt WHERE chosen_printing_id = ${printingId} AND mention_id IS NOT NULL
      )
      ORDER BY a.mention_id, a.created_at DESC, a.id DESC
    ),
    per_content AS (
      SELECT sm.content_id,
        CASE WHEN count(DISTINCT sm.sentiment) FILTER (WHERE sm.sentiment <> 'unknown') > 1 THEN 'mixed'
             ELSE coalesce(max(sm.sentiment) FILTER (WHERE sm.sentiment <> 'unknown'), 'unknown') END AS sentiment
      FROM latest l JOIN source_mention sm ON sm.id = l.mention_id
      WHERE l.status IN ('exact', 'high_confidence') AND l.chosen_printing_id = ${printingId}
      GROUP BY sm.content_id
    )
    SELECT sc.id AS content_id, sc.source_type, sc.title, sc.canonical_url, sc.published_at,
      pc.sentiment, sa.display_name AS account_name
    FROM per_content pc
    JOIN source_content sc ON sc.id = pc.content_id
    LEFT JOIN source_account sa ON sa.id = sc.account_id
    ORDER BY sc.published_at DESC, sc.id DESC
    LIMIT ${EVIDENCE_PAGE_SIZE + 1} OFFSET ${(page - 1) * EVIDENCE_PAGE_SIZE}
  `);
  const rows = asRows(result);
  return {
    page,
    hasMore: rows.length > EVIDENCE_PAGE_SIZE,
    items: rows.slice(0, EVIDENCE_PAGE_SIZE).map((row) => ({
      contentId: String(row.content_id),
      sourceType: String(row.source_type),
      title: row.title == null ? null : String(row.title),
      canonicalUrl: String(row.canonical_url),
      publishedAt: toDate(row.published_at),
      sentiment: String(row.sentiment),
      accountName: row.account_name == null ? null : String(row.account_name),
    })),
  };
}

export type CardCreatorCall = {
  id: string;
  creatorId: string;
  creatorName: string | null;
  direction: string;
  horizonCode: string;
  publishedAt: Date;
  priceAtCall: string | null;
  priceCurrency: string | null;
};

/** Creator calls bound to this printing, newest first, one page at a time. */
export async function listCardCreatorCalls(
  db: Database,
  printingId: string,
  input: { page?: number } = {},
): Promise<{ items: CardCreatorCall[]; hasMore: boolean; page: number }> {
  const page = Math.min(Math.max(1, Math.trunc(input.page ?? 1)), EXPLORER_MAX_PAGE);
  const result = await db.execute(sql`
    SELECT cc.id, cc.creator_id, cr.display_name, cc.direction, cc.horizon_code, cc.published_at,
      cc.price_at_call, cc.price_currency
    FROM creator_call cc
    LEFT JOIN creator cr ON cr.id = cc.creator_id
    WHERE cc.printing_id = ${printingId}
    ORDER BY cc.published_at DESC, cc.id DESC
    LIMIT ${EVIDENCE_PAGE_SIZE + 1} OFFSET ${(page - 1) * EVIDENCE_PAGE_SIZE}
  `);
  const rows = asRows(result);
  return {
    page,
    hasMore: rows.length > EVIDENCE_PAGE_SIZE,
    items: rows.slice(0, EVIDENCE_PAGE_SIZE).map((row) => ({
      id: String(row.id),
      creatorId: String(row.creator_id),
      creatorName: row.display_name == null ? null : String(row.display_name),
      direction: String(row.direction),
      horizonCode: String(row.horizon_code),
      publishedAt: toDate(row.published_at),
      priceAtCall: row.price_at_call == null ? null : String(row.price_at_call),
      priceCurrency: row.price_currency == null ? null : String(row.price_currency),
    })),
  };
}

/**
 * Splits raw sold rows into the single comparable series anchored on the
 * headline price (same currency and condition, ungraded, not an outlier),
 * oldest first, and reports how many rows were left out and why.
 */
export function comparableSoldSeries(
  sold: {
    price: string | null;
    currency: string;
    condition: string;
    gradingCompany: string | null;
    outlierFlag: boolean;
    observedAt: Date;
  }[],
  anchor: { currency: string; condition: string } | null,
): { points: ExplorerSeriesPoint[]; outliers: number; otherGroups: number } {
  if (!anchor) return { points: [], outliers: 0, otherGroups: 0 };
  const points: ExplorerSeriesPoint[] = [];
  let outliers = 0;
  let otherGroups = 0;
  for (const row of sold) {
    const amount = toNumber(row.price);
    if (amount == null) continue;
    if (row.currency !== anchor.currency || row.condition !== anchor.condition || row.gradingCompany != null) {
      otherGroups += 1;
      continue;
    }
    if (row.outlierFlag) {
      outliers += 1;
      continue;
    }
    points.push({ observedAt: row.observedAt, amount });
  }
  points.sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  return { points, outliers, otherGroups };
}

export type SetSummary = {
  setKey: string;
  name: string;
  gameKey: string;
  languageScope: string | null;
  releaseDate: string | null;
  printings: number;
  scored: number;
};

/** Sets with printing and scored-printing counts, newest release first, one page at a time. */
export async function listSetSummaries(
  db: Database,
  input: { page?: number; pageSize?: number; game?: string } = {},
): Promise<{ items: SetSummary[]; total: number; page: number; pageSize: number }> {
  const pageSize = Math.min(Math.max(1, input.pageSize ?? 24), EXPLORER_MAX_PAGE_SIZE);
  const page = Math.min(Math.max(1, Math.trunc(input.page ?? 1)), EXPLORER_MAX_PAGE);
  const result = await db.execute(sql`
    SELECT st.canonical_set_key, st.name, st.game_key, st.language_scope, st.release_date::text AS release_date,
      count(p.id) AS printings,
      count(p.id) FILTER (WHERE EXISTS (SELECT 1 FROM tcg_score_snapshot ss WHERE ss.printing_id = p.id)) AS scored,
      count(*) OVER () AS total
    FROM tcg_set st
    LEFT JOIN tcg_printing p ON p.set_id = st.id AND p.status = 'active'
    WHERE st.status = 'active' ${input.game ? sql`AND st.game_key = ${input.game}` : sql``}
    GROUP BY st.id
    ORDER BY st.release_date DESC NULLS LAST, st.name ASC, st.id ASC
    LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
  `);
  const rows = asRows(result);
  return {
    page,
    pageSize,
    total: rows.length > 0 ? Number(rows[0]!.total) : 0,
    items: rows.map((row) => ({
      setKey: String(row.canonical_set_key),
      name: String(row.name),
      gameKey: String(row.game_key),
      languageScope: row.language_scope == null ? null : String(row.language_scope),
      releaseDate: row.release_date == null ? null : String(row.release_date),
      printings: Number(row.printings),
      scored: Number(row.scored),
    })),
  };
}

export type IndexSummary = {
  indexKey: string;
  name: string;
  gameKey: string;
  languageCode: string | null;
  latest: { value: number; observedAt: Date; coverage: string | null; dataQuality: string | null } | null;
  levels: ExplorerSeriesPoint[];
};

const INDEX_LEVEL_POINTS = 60;

/** Index definitions with their most recent levels (bounded per index) for trend display. */
export async function listIndexSummaries(db: Database, input: { limit?: number } = {}): Promise<IndexSummary[]> {
  const limit = Math.min(Math.max(1, input.limit ?? 24), EXPLORER_MAX_PAGE_SIZE);
  const definitions = asRows(
    await db.execute(sql`
      SELECT index_key, name, game_key, language_code FROM tcg_index_definition
      ORDER BY name ASC, index_key ASC LIMIT ${limit}
    `),
  );
  if (definitions.length === 0) return [];
  const keys = definitions.map((row) => String(row.index_key));
  const levels = asRows(
    await db.execute(sql`
      SELECT index_key, observed_at, index_value, coverage, data_quality FROM (
        SELECT l.*, row_number() OVER (PARTITION BY l.index_key ORDER BY l.observed_at DESC) AS rn
        FROM tcg_index_level l WHERE l.index_key IN (${inList(keys)})
      ) ranked
      WHERE rn <= ${INDEX_LEVEL_POINTS}
      ORDER BY index_key, observed_at ASC
    `),
  );
  const byKey = new Map<string, Record<string, unknown>[]>();
  for (const row of levels) {
    const key = String(row.index_key);
    const list = byKey.get(key) ?? [];
    list.push(row);
    byKey.set(key, list);
  }
  return definitions.map((row) => {
    const key = String(row.index_key);
    const list = byKey.get(key) ?? [];
    const last = list[list.length - 1];
    return {
      indexKey: key,
      name: String(row.name),
      gameKey: String(row.game_key),
      languageCode: row.language_code == null ? null : String(row.language_code),
      latest:
        last == null
          ? null
          : {
              value: toNumber(last.index_value) ?? 0,
              observedAt: toDate(last.observed_at),
              coverage: last.coverage == null ? null : String(last.coverage),
              dataQuality: last.data_quality == null ? null : String(last.data_quality),
            },
      levels: list
        .map((level) => ({ observedAt: toDate(level.observed_at), amount: toNumber(level.index_value) }))
        .filter((point): point is ExplorerSeriesPoint => point.amount != null),
    };
  });
}
