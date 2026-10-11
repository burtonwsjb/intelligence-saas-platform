/**
 * Turns market snapshot rows into one daily series per segment: raw (no
 * grading company) and each grade (e.g. psa10). Segments are never mixed, one
 * price type and one currency are used per segment, and only the most recent
 * stretch of history without long gaps is kept.
 */

/** Gaps up to this many days are carried forward; a longer gap ends the series. */
export const MAX_GAP_DAYS = 7;
/** At most this many daily points are read per segment. */
export const MAX_SERIES_DAYS = 400;
/** Price types a chart may be drawn from, most preferred first on a tie. */
export const CHART_PRICE_TYPES = ["reference", "sold"] as const;

export type ChartInputRow = {
  observedAt: Date;
  priceType: string;
  currency: string;
  gradingCompany: string | null;
  gradeLabel: string | null;
  gradeNumeric: string | null;
  price: number | null;
  salesCount: number | null;
  listingCount: number | null;
  /** Graded population for this grade when the source reports it. */
  population: number | null;
};

export type DailyPoint = {
  day: string;
  price: number;
  /** Units sold that day, when a source reports it; null when unknown. */
  sales: number | null;
  /** Active listings that day, when known. */
  listings: number | null;
  /** Graded population that day, when known. */
  population: number | null;
  /** True when the price was carried forward over a gap of at most MAX_GAP_DAYS. */
  filled: boolean;
};

export type ChartSeries = {
  segment: string;
  gradingCompany: string | null;
  grade: string | null;
  currency: string;
  priceType: string;
  points: DailyPoint[];
  /** Rows left out because they were in another currency than the segment's. */
  otherCurrencyRows: number;
};

const DAY_MS = 86_400_000;

function utcDay(at: Date) {
  return at.toISOString().slice(0, 10);
}

function addDays(day: string, days: number) {
  return utcDay(new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS));
}

function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(`${b}T00:00:00.000Z`) - Date.parse(`${a}T00:00:00.000Z`)) / DAY_MS);
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function gradeText(row: Pick<ChartInputRow, "gradeLabel" | "gradeNumeric">) {
  if (row.gradeNumeric != null && row.gradeNumeric !== "" && Number.isFinite(Number(row.gradeNumeric))) {
    return String(Number(row.gradeNumeric));
  }
  return row.gradeLabel?.trim() || null;
}

/** "raw", or the grading company and grade, e.g. psa10, bgs9_5, cgc10_pristine. */
export function segmentKey(row: Pick<ChartInputRow, "gradingCompany" | "gradeLabel" | "gradeNumeric">): string {
  if (!row.gradingCompany) return "raw";
  const company = row.gradingCompany.toLowerCase().replace(/[^a-z0-9]/g, "");
  const grade = (gradeText(row) ?? "ungraded").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return `${company || "graded"}${grade}`;
}

function pickMost<T extends string>(counts: Map<T, number>, preference: readonly string[]): T | null {
  let best: T | null = null;
  let bestCount = -1;
  for (const [key, count] of counts) {
    const better =
      count > bestCount ||
      (count === bestCount && best != null && rank(key, preference) < rank(best, preference)) ||
      (count === bestCount && best != null && rank(key, preference) === rank(best, preference) && key < best);
    if (better) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

function rank(key: string, preference: readonly string[]) {
  const index = preference.indexOf(key);
  return index < 0 ? preference.length : index;
}

/**
 * Builds the daily series of every segment present in `rows`. Rows must
 * already exclude outliers. Raw comes first, then graded segments by key.
 */
export function buildChartSeries(rows: readonly ChartInputRow[]): ChartSeries[] {
  const bySegment = new Map<string, ChartInputRow[]>();
  for (const row of rows) {
    const key = segmentKey(row);
    const list = bySegment.get(key);
    if (list) list.push(row);
    else bySegment.set(key, [row]);
  }
  const out: ChartSeries[] = [];
  for (const [segment, segmentRows] of bySegment) {
    const series = buildSegment(segment, segmentRows);
    if (series) out.push(series);
  }
  return out.sort((a, b) => (a.segment === "raw" ? -1 : b.segment === "raw" ? 1 : a.segment.localeCompare(b.segment)));
}

function buildSegment(segment: string, rows: ChartInputRow[]): ChartSeries | null {
  const priced = rows.filter(
    (row) => row.price != null && Number.isFinite(row.price) && row.price > 0 && (CHART_PRICE_TYPES as readonly string[]).includes(row.priceType),
  );
  // One price type: the one with the most days of history.
  const typeDays = new Map<string, Set<string>>();
  for (const row of priced) {
    const days = typeDays.get(row.priceType) ?? new Set<string>();
    days.add(utcDay(row.observedAt));
    typeDays.set(row.priceType, days);
  }
  const priceType = pickMost(new Map([...typeDays].map(([key, days]) => [key, days.size])), CHART_PRICE_TYPES);
  if (!priceType) return null;
  const typed = priced.filter((row) => row.priceType === priceType);
  // One currency: the one most rows are in. Others are counted, never converted.
  const currencyCounts = new Map<string, number>();
  for (const row of typed) currencyCounts.set(row.currency, (currencyCounts.get(row.currency) ?? 0) + 1);
  const currency = pickMost(currencyCounts, ["USD"])!;
  const otherCurrencyRows = typed.filter((row) => row.currency !== currency).length;

  const prices = new Map<string, number[]>();
  for (const row of typed) {
    if (row.currency !== currency) continue;
    const day = utcDay(row.observedAt);
    const list = prices.get(day);
    if (list) list.push(row.price!);
    else prices.set(day, [row.price!]);
  }
  // Demand and population may come from any row of the segment in that currency
  // (a listing row carries the listing count, a sold summary the sales count).
  const sales = new Map<string, number>();
  const listings = new Map<string, number>();
  const population = new Map<string, number>();
  for (const row of rows) {
    if (row.currency !== currency) continue;
    const day = utcDay(row.observedAt);
    if (row.salesCount != null && row.salesCount >= 0) sales.set(day, (sales.get(day) ?? 0) + row.salesCount);
    if (row.listingCount != null && row.listingCount >= 0) listings.set(day, Math.max(listings.get(day) ?? 0, row.listingCount));
    if (row.population != null && row.population >= 0) population.set(day, Math.max(population.get(day) ?? 0, row.population));
  }

  const days = [...prices.keys()].sort();
  if (days.length === 0) return null;
  // Walk back from the newest day until a gap longer than MAX_GAP_DAYS.
  let start = days.length - 1;
  while (start > 0 && daysBetween(days[start - 1]!, days[start]!) <= MAX_GAP_DAYS) start -= 1;
  const kept = days.slice(start);
  const points: DailyPoint[] = [];
  let day = kept[0]!;
  const last = kept[kept.length - 1]!;
  let price = median(prices.get(day)!);
  while (day <= last) {
    const observed = prices.get(day);
    if (observed) price = median(observed);
    points.push({
      day,
      price,
      sales: sales.get(day) ?? null,
      listings: listings.get(day) ?? null,
      population: population.get(day) ?? null,
      filled: !observed,
    });
    day = addDays(day, 1);
  }
  const first = rows.find((row) => row.gradingCompany);
  return {
    segment,
    gradingCompany: first?.gradingCompany ?? null,
    grade: first ? gradeText(first) : null,
    currency,
    priceType,
    points: points.slice(-MAX_SERIES_DAYS),
    otherCurrencyRows,
  };
}
