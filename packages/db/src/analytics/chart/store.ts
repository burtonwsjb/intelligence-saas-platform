/**
 * Chart Sentiment storage: the worker job that scores printings in bounded
 * batches and writes one chart_sentiment row per printing and segment, the
 * pattern database sync (catalog rows plus hit rates measured on our own card
 * history), and the read used by the API and the web card page.
 *
 * Inputs are tcg_market_snapshot rows that are not outliers, read per
 * printing through its (printing_id, observed_at) index. Database only: no
 * provider requests.
 */
import { sql } from "drizzle-orm";
import type { Database } from "../../client.js";
import { CHART_CATALOG_VERSION, CHART_PATTERN_BY_KEY, CHART_PATTERNS } from "./patterns.js";
import {
  backtestChartSeries,
  CHART_METHOD_VERSION,
  scoreChartSeries,
  type ChartBacktest,
  type ChartInsufficient,
  type ChartLabel,
  type ChartSignal,
  type PatternStats,
} from "./score.js";
import { buildChartSeries, MAX_GAP_DAYS, MAX_SERIES_DAYS, type ChartInputRow } from "./series.js";

export const DEFAULT_CHART_SENTIMENT_BATCH_SIZE = 200;
export const CHART_SENTIMENT_MAX_BATCH_SIZE = 2_000;
/** A printing is recomputed at most this often, so the hourly job works through the catalog about once a day. */
export const CHART_SENTIMENT_RECOMPUTE_HOURS = 20;
/** History read per printing: the longest series kept plus room for a gap at its start. */
export const CHART_SENTIMENT_READ_DAYS = MAX_SERIES_DAYS + MAX_GAP_DAYS + 3;

const DAY_MS = 86_400_000;

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

/** CHART_SENTIMENT_BATCH_SIZE: printings scored per hourly run (0 turns the job off). */
export function chartSentimentBatchSize(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.CHART_SENTIMENT_BATCH_SIZE;
  if (value == null || value.trim() === "") return DEFAULT_CHART_SENTIMENT_BATCH_SIZE;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > CHART_SENTIMENT_MAX_BATCH_SIZE) {
    throw new Error("Invalid CHART_SENTIMENT_BATCH_SIZE configuration.");
  }
  return parsed;
}

/** False until migration 0033 has been applied. */
export async function chartTablesExist(db: Database): Promise<boolean> {
  const rows = rowsOf<{ ok: boolean }>(
    await db.execute(sql`select to_regclass('public.chart_sentiment') is not null and to_regclass('public.chart_pattern') is not null as ok`),
  );
  return rows[0]?.ok === true;
}

/** Writes the committed catalog into chart_pattern, keeping measured stats. */
export async function syncChartPatternCatalog(db: Database): Promise<number> {
  for (const p of CHART_PATTERNS) {
    await db.execute(sql`
      INSERT INTO chart_pattern (key, name, category, direction, horizon_days, min_points, requires,
        base_weight, prior_hit_rate, rule, explanation, catalog_version, updated_at)
      VALUES (${p.key}, ${p.name}, ${p.category}, ${p.direction}, ${p.horizonDays}, ${p.minPoints}, ${p.requires ?? null},
        ${p.baseWeight}, ${p.priorHitRate}, ${p.rule}, ${p.explanation}, ${CHART_CATALOG_VERSION}, now())
      ON CONFLICT (key) DO UPDATE SET
        name = EXCLUDED.name, category = EXCLUDED.category, direction = EXCLUDED.direction,
        horizon_days = EXCLUDED.horizon_days, min_points = EXCLUDED.min_points, requires = EXCLUDED.requires,
        base_weight = EXCLUDED.base_weight, prior_hit_rate = EXCLUDED.prior_hit_rate, rule = EXCLUDED.rule,
        explanation = EXCLUDED.explanation, catalog_version = EXCLUDED.catalog_version, updated_at = now()
      WHERE (chart_pattern.name, chart_pattern.rule, chart_pattern.explanation, chart_pattern.catalog_version,
             chart_pattern.base_weight, chart_pattern.prior_hit_rate, chart_pattern.horizon_days, chart_pattern.min_points)
        IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.rule, EXCLUDED.explanation, EXCLUDED.catalog_version,
             EXCLUDED.base_weight, EXCLUDED.prior_hit_rate, EXCLUDED.horizon_days, EXCLUDED.min_points)
    `);
  }
  return CHART_PATTERNS.length;
}

/** Measured samples and hits per pattern, as stored in chart_pattern. */
export async function loadChartPatternStats(db: Database): Promise<Map<string, PatternStats>> {
  const rows = rowsOf<{ key: string; samples: number; hits: number }>(
    await db.execute(sql`SELECT key, samples, hits FROM chart_pattern`),
  );
  return new Map(rows.map((row) => [row.key, { samples: Number(row.samples), hits: Number(row.hits) }]));
}

/**
 * Sums every stored segment's backtest into chart_pattern. Each segment's
 * backtest replaces its previous one when the segment is recomputed, so a
 * sample is never counted twice.
 */
export async function refreshChartPatternStats(db: Database, asOf: Date = new Date()): Promise<number> {
  const rows = rowsOf<{ key: string; samples: string; hits: string; flat: string }>(
    await db.execute(sql`
      SELECT b.key,
        sum(COALESCE((b.value->>'samples')::int, 0)) AS samples,
        sum(COALESCE((b.value->>'hits')::int, 0)) AS hits,
        sum(COALESCE((b.value->>'flat')::int, 0)) AS flat
      FROM chart_sentiment cs, jsonb_each(cs.backtest) b
      GROUP BY b.key
    `),
  );
  const totals = new Map(rows.map((row) => [row.key, { samples: Number(row.samples), hits: Number(row.hits), flat: Number(row.flat) }]));
  let updated = 0;
  for (const pattern of CHART_PATTERNS) {
    const t = totals.get(pattern.key) ?? { samples: 0, hits: 0, flat: 0 };
    const rate = t.samples > 0 ? (t.hits / t.samples).toFixed(4) : null;
    await db.execute(sql`
      UPDATE chart_pattern SET samples = ${t.samples}, hits = ${t.hits}, flat = ${t.flat},
        measured_hit_rate = ${rate}, measured_at = ${asOf.toISOString()}::timestamptz
      WHERE key = ${pattern.key}
    `);
    updated += 1;
  }
  return updated;
}

type SnapshotRow = {
  observed_at: Date | string;
  price_type: string;
  currency: string;
  grading_company: string | null;
  grade_label: string | null;
  grade_numeric: string | null;
  price: string | null;
  sales_count: number | null;
  listing_count: number | null;
  population: number | null;
};

/** Non-outlier market rows of one printing over the chart window, oldest first. */
export async function loadChartInputRows(db: Database, printingId: string, asOf: Date): Promise<ChartInputRow[]> {
  const from = new Date(asOf.getTime() - CHART_SENTIMENT_READ_DAYS * DAY_MS);
  const rows = rowsOf<SnapshotRow>(
    await db.execute(sql`
      SELECT observed_at, price_type, currency, grading_company, grade_label, grade_numeric::text AS grade_numeric,
        price::text AS price, sales_count, listing_count,
        CASE WHEN attributes->>'population' ~ '^[0-9]{1,9}$' THEN (attributes->>'population')::int END AS population
      FROM tcg_market_snapshot
      WHERE printing_id = ${printingId}
        AND observed_at >= ${from.toISOString()}::timestamptz
        AND observed_at <= ${asOf.toISOString()}::timestamptz
        AND outlier_flag = false
        AND quality_label NOT IN ('outlier', 'suspect')
      ORDER BY observed_at ASC
    `),
  );
  return rows.map((row) => ({
    observedAt: row.observed_at instanceof Date ? row.observed_at : new Date(row.observed_at),
    priceType: row.price_type,
    currency: row.currency,
    gradingCompany: row.grading_company,
    gradeLabel: row.grade_label,
    gradeNumeric: row.grade_numeric,
    price: row.price == null ? null : Number(row.price),
    salesCount: row.sales_count == null ? null : Number(row.sales_count),
    listingCount: row.listing_count == null ? null : Number(row.listing_count),
    population: row.population == null ? null : Number(row.population),
  }));
}

/** Scores every segment of one printing and replaces its stored rows. Returns the segments written. */
export async function computePrintingChartSentiment(
  db: Database,
  printingId: string,
  stats: ReadonlyMap<string, PatternStats>,
  asOf: Date,
): Promise<string[]> {
  const series = buildChartSeries(await loadChartInputRows(db, printingId, asOf));
  const written: string[] = [];
  for (const one of series) {
    const result = scoreChartSeries(one, stats, asOf);
    const backtest: ChartBacktest = backtestChartSeries(one);
    await db.execute(sql`
      INSERT INTO chart_sentiment (printing_id, segment, grading_company, grade, currency, price_type, score, label,
        confidence, points, data_from, data_through, last_price, signals, insufficient, inputs, backtest,
        method_version, catalog_version, computed_at)
      VALUES (${printingId}, ${result.segment}, ${result.gradingCompany}, ${result.grade}, ${result.currency}, ${result.priceType},
        ${result.score}, ${result.label}, ${result.confidence.toFixed(3)}, ${result.points}, ${result.dataFrom}, ${result.dataThrough},
        ${result.lastPrice == null ? null : String(result.lastPrice)},
        ${JSON.stringify(result.signals)}::jsonb, ${JSON.stringify(result.insufficient)}::jsonb, ${JSON.stringify(result.inputs)}::jsonb,
        ${JSON.stringify(backtest)}::jsonb, ${CHART_METHOD_VERSION}, ${CHART_CATALOG_VERSION}, ${asOf.toISOString()}::timestamptz)
      ON CONFLICT (printing_id, segment) DO UPDATE SET
        grading_company = EXCLUDED.grading_company, grade = EXCLUDED.grade, currency = EXCLUDED.currency,
        price_type = EXCLUDED.price_type, score = EXCLUDED.score, label = EXCLUDED.label, confidence = EXCLUDED.confidence,
        points = EXCLUDED.points, data_from = EXCLUDED.data_from, data_through = EXCLUDED.data_through,
        last_price = EXCLUDED.last_price, signals = EXCLUDED.signals, insufficient = EXCLUDED.insufficient,
        inputs = EXCLUDED.inputs, backtest = EXCLUDED.backtest, method_version = EXCLUDED.method_version,
        catalog_version = EXCLUDED.catalog_version, computed_at = EXCLUDED.computed_at
    `);
    written.push(result.segment);
  }
  // Segments that no longer have data (e.g. a grade whose only rows were later flagged) are removed.
  if (written.length === 0) {
    await db.execute(sql`DELETE FROM chart_sentiment WHERE printing_id = ${printingId}`);
  } else {
    await db.execute(sql`
      DELETE FROM chart_sentiment WHERE printing_id = ${printingId}
        AND segment NOT IN (${sql.join(written.map((segment) => sql`${segment}`), sql`, `)})
    `);
  }
  return written;
}

export type ChartSentimentRunReport = {
  status: "completed" | "skipped";
  reason: string | null;
  considered: number;
  printings: number;
  segments: number;
  failed: number;
  patternsUpdated: number;
};

/**
 * One bounded batch: printings with chart-usable prices in the read window
 * that were never scored, or not within CHART_SENTIMENT_RECOMPUTE_HOURS, oldest
 * first. Then the pattern database's measured hit rates are refreshed.
 * Idempotent: rerunning replaces the same rows. With `exclusive`, call inside
 * a transaction; another run holding the lock makes this one skip.
 */
export async function runChartSentimentBatch(
  db: Database,
  input: { asOf?: Date; batchSize?: number; exclusive?: boolean } = {},
): Promise<ChartSentimentRunReport> {
  const report: ChartSentimentRunReport = { status: "completed", reason: null, considered: 0, printings: 0, segments: 0, failed: 0, patternsUpdated: 0 };
  const batchSize = Math.max(0, Math.min(input.batchSize ?? DEFAULT_CHART_SENTIMENT_BATCH_SIZE, CHART_SENTIMENT_MAX_BATCH_SIZE));
  if (batchSize === 0) return { ...report, status: "skipped", reason: "disabled" };
  if (!(await chartTablesExist(db))) return { ...report, status: "skipped", reason: "tables_missing" };
  if (input.exclusive) {
    const lock = rowsOf<{ locked: boolean }>(
      await db.execute(sql`select pg_try_advisory_xact_lock(hashtext('chart.sentiment.v1')) as locked`),
    );
    if (!lock[0]?.locked) return { ...report, status: "skipped", reason: "overlap" };
  }
  const asOf = input.asOf ?? new Date();
  await syncChartPatternCatalog(db);
  const stats = await loadChartPatternStats(db);
  const from = new Date(asOf.getTime() - CHART_SENTIMENT_READ_DAYS * DAY_MS);
  const staleBefore = new Date(asOf.getTime() - CHART_SENTIMENT_RECOMPUTE_HOURS * 3_600_000);
  const due = rowsOf<{ printing_id: string }>(
    await db.execute(sql`
      SELECT p.printing_id
      FROM (
        SELECT DISTINCT printing_id FROM tcg_market_snapshot
        WHERE price_type IN ('reference', 'sold') AND price IS NOT NULL AND outlier_flag = false
          AND quality_label NOT IN ('outlier', 'suspect')
          AND observed_at >= ${from.toISOString()}::timestamptz
          AND observed_at <= ${asOf.toISOString()}::timestamptz
      ) p
      LEFT JOIN (SELECT printing_id, min(computed_at) AS computed_at FROM chart_sentiment GROUP BY printing_id) c
        ON c.printing_id = p.printing_id
      WHERE c.computed_at IS NULL OR c.computed_at < ${staleBefore.toISOString()}::timestamptz
      ORDER BY c.computed_at ASC NULLS FIRST, p.printing_id ASC
      LIMIT ${batchSize}
    `),
  );
  report.considered = due.length;
  for (const row of due) {
    try {
      const segments = await computePrintingChartSentiment(db, row.printing_id, stats, asOf);
      report.printings += 1;
      report.segments += segments.length;
    } catch {
      report.failed += 1;
    }
  }
  if (report.printings > 0) report.patternsUpdated = await refreshChartPatternStats(db, asOf);
  return report;
}

export type ChartSentimentSignalView = ChartSignal & { explanation: string; horizonDays: number };

export type ChartSentimentSegmentView = {
  segment: string;
  gradingCompany: string | null;
  grade: string | null;
  currency: string | null;
  priceType: string | null;
  score: number | null;
  label: ChartLabel;
  confidence: number;
  points: number;
  dataFrom: string | null;
  dataThrough: string | null;
  lastPrice: number | null;
  change30dPct: number | null;
  signals: ChartSentimentSignalView[];
  insufficient: ChartInsufficient[];
  methodVersion: string;
  computedAt: Date;
};

export type PrintingChartSentiment = {
  raw: ChartSentimentSegmentView | null;
  graded: ChartSentimentSegmentView[];
};

type StoredRow = {
  printing_id: string;
  segment: string;
  grading_company: string | null;
  grade: string | null;
  currency: string | null;
  price_type: string | null;
  score: number | null;
  label: ChartLabel;
  confidence: string;
  points: number;
  data_from: string | Date | null;
  data_through: string | Date | null;
  last_price: string | null;
  signals: unknown;
  insufficient: unknown;
  inputs: unknown;
  method_version: string;
  computed_at: Date | string;
};

function dayText(value: string | Date | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function json<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function segmentView(row: StoredRow): ChartSentimentSegmentView {
  const signals = json<ChartSignal[]>(row.signals, []).map((signal) => {
    const pattern = CHART_PATTERN_BY_KEY.get(signal.key);
    return { ...signal, explanation: pattern?.explanation ?? "", horizonDays: pattern?.horizonDays ?? 0 };
  });
  const inputs = json<{ change30dPct?: number | null }>(row.inputs, {});
  return {
    segment: row.segment,
    gradingCompany: row.grading_company,
    grade: row.grade,
    currency: row.currency,
    priceType: row.price_type,
    score: row.score == null ? null : Number(row.score),
    label: row.label,
    confidence: Number(row.confidence),
    points: Number(row.points),
    dataFrom: dayText(row.data_from),
    dataThrough: dayText(row.data_through),
    lastPrice: row.last_price == null ? null : Number(row.last_price),
    change30dPct: inputs.change30dPct ?? null,
    signals,
    insufficient: json<ChartInsufficient[]>(row.insufficient, []),
    methodVersion: row.method_version,
    computedAt: row.computed_at instanceof Date ? row.computed_at : new Date(row.computed_at),
  };
}

function isUndefinedTable(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ((current as { code?: unknown }).code === "42P01") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Stored Chart Sentiment for each printing: raw first, then each grade by
 * segment key. Printings never scored are absent from the map. Before
 * migration 0033 is applied the map is empty instead of an error.
 */
export async function getChartSentiment(db: Database, printingIds: readonly string[]): Promise<Map<string, PrintingChartSentiment>> {
  const out = new Map<string, PrintingChartSentiment>();
  const ids = [...new Set(printingIds)];
  if (ids.length === 0) return out;
  let rows: StoredRow[];
  try {
    rows = rowsOf<StoredRow>(
      await db.execute(sql`
        SELECT printing_id, segment, grading_company, grade, currency, price_type, score, label, confidence::text AS confidence,
          points, data_from::text AS data_from, data_through::text AS data_through, last_price::text AS last_price,
          signals, insufficient, inputs, method_version, computed_at
        FROM chart_sentiment
        WHERE printing_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
        ORDER BY printing_id, (segment = 'raw') DESC, segment ASC
      `),
    );
  } catch (error) {
    if (isUndefinedTable(error)) return out;
    throw error;
  }
  for (const row of rows) {
    const entry = out.get(row.printing_id) ?? { raw: null, graded: [] };
    const view = segmentView(row);
    if (row.segment === "raw") entry.raw = view;
    else entry.graded.push(view);
    out.set(row.printing_id, entry);
  }
  return out;
}

/** The pattern database with measured hit rates, for documentation and admin views. */
export async function listChartPatterns(db: Database) {
  return rowsOf<{
    key: string;
    name: string;
    category: string;
    direction: string;
    horizon_days: number;
    rule: string;
    explanation: string;
    prior_hit_rate: string;
    samples: number;
    hits: number;
    measured_hit_rate: string | null;
  }>(
    await db.execute(sql`
      SELECT key, name, category, direction, horizon_days, rule, explanation, prior_hit_rate::text AS prior_hit_rate,
        samples, hits, measured_hit_rate::text AS measured_hit_rate
      FROM chart_pattern ORDER BY category, key
    `),
  );
}
