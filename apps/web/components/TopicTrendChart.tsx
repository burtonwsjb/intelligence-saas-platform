import { formatDate } from "@/lib/display";
import type { TopicBucket } from "@isp/db";

const SERIES = [
  { key: "positive", label: "Bullish / positive", color: "var(--sent-positive)" },
  { key: "neutral", label: "Neutral", color: "var(--sent-neutral)" },
  { key: "mixed", label: "Mixed", color: "var(--sent-mixed)" },
  { key: "negative", label: "Bearish / negative", color: "var(--sent-negative)" },
] as const;

/**
 * Posts per period, stacked by sentiment. Unclassified posts are left out of
 * the bars and counted in the caption, so an empty period reads as no posts,
 * never as neutral.
 */
export function TopicTrendChart({ buckets, bucketDays }: { buckets: TopicBucket[]; bucketDays: number }) {
  const width = 960;
  const height = 220;
  const plot = { left: 40, right: width - 8, top: 12, bottom: height - 28 };
  const totals = buckets.map((bucket) => SERIES.reduce((sum, series) => sum + bucket[series.key], 0));
  const max = Math.max(1, ...totals);
  const unknown = buckets.reduce((sum, bucket) => sum + bucket.unknown, 0);
  if (totals.every((total) => total === 0)) {
    return <p className="subtle">No classified posts in this window yet.</p>;
  }
  const step = (plot.right - plot.left) / Math.max(1, buckets.length);
  const barWidth = Math.max(4, Math.min(48, step * 0.7));
  const y = (value: number) => plot.bottom - (value / max) * (plot.bottom - plot.top);
  const period = bucketDays === 1 ? "day" : `${bucketDays} days`;
  return (
    <figure className="chart" style={{ margin: 0 }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Classified posts per ${period}, stacked by sentiment`}
      >
        {[0, max].map((tick) => (
          <g key={tick}>
            <line className="grid-line" x1={plot.left} x2={plot.right} y1={y(tick)} y2={y(tick)} />
            <text x={plot.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="central" className="axis-label">
              {tick}
            </text>
          </g>
        ))}
        {buckets.map((bucket, index) => {
          const x = plot.left + index * step + (step - barWidth) / 2;
          let base = 0;
          return (
            <g key={bucket.start.toISOString()}>
              <title>
                {`${formatDate(bucket.start)}: ${SERIES.map((series) => `${bucket[series.key]} ${series.label.toLowerCase()}`).join(", ")}`}
              </title>
              {SERIES.map((series) => {
                const value = bucket[series.key];
                if (value === 0) return null;
                const top = y(base + value);
                const rect = (
                  <rect
                    key={series.key}
                    x={x}
                    y={top}
                    width={barWidth}
                    height={Math.max(1, y(base) - top - 1)}
                    rx={2}
                    fill={series.color}
                  />
                );
                base += value;
                return rect;
              })}
            </g>
          );
        })}
        {[0, buckets.length - 1].map((index) =>
          buckets[index] ? (
            <text
              key={index}
              x={plot.left + index * step + step / 2}
              y={height - 8}
              textAnchor={index === 0 ? "start" : "end"}
              className="axis-label"
            >
              {formatDate(buckets[index]!.start)}
            </text>
          ) : null,
        )}
      </svg>
      <figcaption className="subtle">
        <ul className="legend" style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3)" }}>
          {SERIES.map((series) => (
            <li key={series.key}>
              <span className="swatch" style={{ background: series.color }} aria-hidden="true" />
              <span>{series.label}</span>
            </li>
          ))}
        </ul>
        Posts per {period}, counted once each.{unknown > 0 ? ` ${unknown} ${unknown === 1 ? "post" : "posts"} with no clear sentiment ${unknown === 1 ? "is" : "are"} not shown.` : ""}
      </figcaption>
    </figure>
  );
}
