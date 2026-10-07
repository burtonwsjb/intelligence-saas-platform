// Plain-language labels and chart geometry for the customer app. Pure functions
// only: no scoring happens here, the inputs are persisted values.

export const RECOMMENDATION_TEXT: Record<string, string> = {
  strong_buy: "Strong buy",
  buy: "Buy",
  watch: "Watch",
  hold: "Hold",
  reduce: "Reduce",
  sell: "Sell",
  strong_sell: "Strong sell",
  insufficient_data: "Not enough data",
};

export function recommendationText(value: string | null | undefined): string {
  if (!value) return "No recommendation";
  return RECOMMENDATION_TEXT[value] ?? value.replaceAll("_", " ");
}

export const CONFIRMATION_TEXT = {
  confirmed: { label: "Market-confirmed", tone: "good" },
  unconfirmed: { label: "Not confirmed by sales", tone: "warn" },
  insufficient: { label: "Insufficient market evidence", tone: "info" },
  no_score: { label: "Not scored yet", tone: "info" },
} as const;

export const LANGUAGE_TEXT: Record<string, string> = {
  en: "English",
  ja: "Japanese",
  "zh-Hans": "Simplified Chinese",
  zh_hans: "Simplified Chinese",
  "zh-CN": "Simplified Chinese",
};

export function languageText(code: string): string {
  return LANGUAGE_TEXT[code] ?? code.toUpperCase();
}

export function variantText(variant: string): string {
  return variant.replaceAll("_", " ").replace(/^\w/, (char) => char.toUpperCase());
}

export function conditionText(condition: string): string {
  const map: Record<string, string> = {
    nm: "Near Mint",
    lp: "Lightly Played",
    mp: "Moderately Played",
    hp: "Heavily Played",
    dmg: "Damaged",
  };
  return map[condition.toLowerCase()] ?? condition.toUpperCase();
}

export function formatScore(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return String(Math.round(value));
}

export function formatChange(value: number | null): { text: string; direction: "up" | "down" | "flat" } | null {
  if (value == null || !Number.isFinite(value)) return null;
  const pct = value * 100;
  const rounded = Math.abs(pct) < 0.05 ? 0 : pct;
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "";
  return {
    text: `${sign}${Math.abs(rounded).toFixed(1)}%`,
    direction: rounded > 0 ? "up" : rounded < 0 ? "down" : "flat",
  };
}

export function formatAge(from: Date | null | undefined, now: Date = new Date()): string {
  if (!from) return "never";
  const minutes = Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days}d ago`;
  return `${Math.round(days / 30)} months ago`;
}

export function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export type Freshness = { label: string; tone: "good" | "warn" | "info" };

/** Freshness of the headline price: missing is not fresh, stale is labeled. */
export function priceFreshness(observedAt: Date | null | undefined, now: Date = new Date()): Freshness {
  if (!observedAt) return { label: "No sales data", tone: "info" };
  const hours = (now.getTime() - observedAt.getTime()) / 3_600_000;
  if (hours <= 24) return { label: "Fresh", tone: "good" };
  if (hours <= 24 * 7) return { label: `Updated ${formatAge(observedAt, now)}`, tone: "info" };
  return { label: `Stale · ${formatAge(observedAt, now)}`, tone: "warn" };
}

export const DATA_QUALITY_TEXT: Record<string, { label: string; tone: "good" | "warn" | "info" }> = {
  ok: { label: "Good data", tone: "good" },
  complete: { label: "Good data", tone: "good" },
  partial: { label: "Partial data", tone: "info" },
  thin: { label: "Thin market", tone: "warn" },
  stale: { label: "Stale data", tone: "warn" },
  outlier_dependent: { label: "Outlier-dependent", tone: "warn" },
  insufficient_data: { label: "Not enough data", tone: "info" },
};

export function dataQualityText(value: string): { label: string; tone: "good" | "warn" | "info" } {
  return DATA_QUALITY_TEXT[value] ?? { label: value.replaceAll("_", " "), tone: "info" };
}

export function monogram(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
}

// ---------- Chart geometry ----------

export type Point = { observedAt: Date; amount: number };

export type ChartGeometry = {
  width: number;
  height: number;
  plot: { left: number; right: number; top: number; bottom: number };
  points: { x: number; y: number; observedAt: Date; amount: number }[];
  line: string;
  area: string;
  yTicks: { y: number; value: number }[];
  domain: { min: number; max: number; from: Date; to: Date };
};

/**
 * X is positioned by observation time, not index, so gaps in the record stay
 * visible as gaps rather than being compressed into an even series.
 */
export function timeSeriesGeometry(
  input: Point[],
  options: { width?: number; height?: number; padding?: Partial<ChartGeometry["plot"]>; ticks?: number } = {},
): ChartGeometry | null {
  const points = input
    .filter((point) => Number.isFinite(point.amount))
    .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  if (points.length === 0) return null;
  const width = options.width ?? 960;
  const height = options.height ?? 300;
  const plot = {
    left: options.padding?.left ?? 72,
    right: width - (options.padding?.right ?? 12),
    top: options.padding?.top ?? 12,
    bottom: height - (options.padding?.bottom ?? 28),
  };
  const amounts = points.map((point) => point.amount);
  let min = Math.min(...amounts);
  let max = Math.max(...amounts);
  if (min === max) {
    const pad = Math.abs(min) * 0.05 || 1;
    min -= pad;
    max += pad;
  } else {
    const pad = (max - min) * 0.08;
    min = Math.max(0, min - pad);
    max += pad;
  }
  const from = points[0]!.observedAt;
  const to = points[points.length - 1]!.observedAt;
  const span = to.getTime() - from.getTime();
  const x = (date: Date) =>
    span === 0 ? (plot.left + plot.right) / 2 : plot.left + ((date.getTime() - from.getTime()) / span) * (plot.right - plot.left);
  const y = (value: number) => plot.bottom - ((value - min) / (max - min)) * (plot.bottom - plot.top);
  const mapped = points.map((point) => ({
    x: round(x(point.observedAt)),
    y: round(y(point.amount)),
    observedAt: point.observedAt,
    amount: point.amount,
  }));
  const line = mapped.map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`).join(" ");
  const area =
    mapped.length > 1
      ? `${line} L${mapped[mapped.length - 1]!.x},${plot.bottom} L${mapped[0]!.x},${plot.bottom} Z`
      : "";
  const tickCount = options.ticks ?? 3;
  const yTicks = Array.from({ length: tickCount }, (_, index) => {
    const value = min + ((max - min) * index) / Math.max(1, tickCount - 1);
    return { y: round(y(value)), value };
  });
  return { width, height, plot, points: mapped, line, area, yTicks, domain: { min, max, from, to } };
}

export type DonutSegment = { key: string; value: number; path: string; share: number };

/** Arc paths for a donut; zero-value segments are omitted, a single segment is a full ring. */
export function donutSegments(
  values: { key: string; value: number }[],
  options: { size?: number; thickness?: number; gap?: number } = {},
): DonutSegment[] {
  const size = options.size ?? 140;
  const thickness = options.thickness ?? 18;
  const total = values.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  if (total <= 0) return [];
  const r = size / 2 - thickness / 2;
  const c = size / 2;
  const present = values.filter((item) => item.value > 0);
  const gap = present.length > 1 ? (options.gap ?? 0.03) : 0;
  let angle = -Math.PI / 2;
  return present.map((item) => {
    const share = item.value / total;
    const sweep = share * Math.PI * 2;
    if (present.length === 1) {
      const path = `M${c},${round(c - r)} A${r},${r} 0 1 1 ${round(c - 0.01)},${round(c - r)}`;
      angle += sweep;
      return { key: item.key, value: item.value, share, path };
    }
    const start = angle + gap / 2;
    const end = angle + sweep - gap / 2;
    angle += sweep;
    const large = end - start > Math.PI ? 1 : 0;
    const path = `M${round(c + r * Math.cos(start))},${round(c + r * Math.sin(start))} A${r},${r} 0 ${large} 1 ${round(
      c + r * Math.cos(end),
    )},${round(c + r * Math.sin(end))}`;
    return { key: item.key, value: item.value, share, path };
  });
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
