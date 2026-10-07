import { donutSegments, formatDate } from "@/lib/display";
import { SENTIMENT_KEYS, SENTIMENT_LABEL_TEXT, SENTIMENT_MIN_SAMPLE, type SentimentSummary as Summary } from "@isp/db";

const KEY_TEXT: Record<(typeof SENTIMENT_KEYS)[number], string> = {
  positive: "Bullish / positive",
  neutral: "Neutral",
  negative: "Bearish / negative",
  mixed: "Mixed within one post",
};

const KEY_COLOR: Record<(typeof SENTIMENT_KEYS)[number], string> = {
  positive: "var(--sent-positive)",
  neutral: "var(--sent-neutral)",
  negative: "var(--sent-negative)",
  mixed: "var(--sent-mixed)",
};

export function SentimentLabel({ summary }: { summary: Summary }) {
  return <span>{SENTIMENT_LABEL_TEXT[summary.label]}</span>;
}

/**
 * Distribution of classified posts. The denominator, distinct accounts, window
 * and basis are always printed next to the chart. No evidence is an empty ring,
 * never a neutral or 0% bullish reading.
 */
export function SentimentDonut({ summary }: { summary: Summary }) {
  const size = 148;
  const segments = donutSegments(
    SENTIMENT_KEYS.map((key) => ({ key, value: summary.counts[key] })),
    { size, thickness: 18 },
  );
  const r = size / 2 - 9;
  const window = `${formatDate(summary.from)} to ${formatDate(summary.to)}`;
  return (
    <figure className="donut-wrap" style={{ margin: 0 }}>
      <svg
        className="donut"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={
          summary.classified === 0
            ? "No classified social posts in this window"
            : `Sentiment of ${summary.classified} classified posts: ${SENTIMENT_KEYS.map((key) => `${summary.counts[key]} ${key}`).join(", ")}`
        }
      >
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--chart-track)" strokeWidth={18} />
        {segments.map((segment) => (
          <path
            key={segment.key}
            d={segment.path}
            fill="none"
            stroke={KEY_COLOR[segment.key as keyof typeof KEY_COLOR]}
            strokeWidth={18}
          />
        ))}
        <text className="donut-center" x="50%" y="47%" textAnchor="middle" dominantBaseline="central">
          {summary.classified}
        </text>
        <text className="donut-center-note" x="50%" y="62%" textAnchor="middle">
          {summary.classified === 1 ? "post" : "posts"}
        </text>
      </svg>
      <figcaption style={{ display: "grid", gap: "var(--space-3)", minWidth: "14rem", flex: "1 1 14rem" }}>
        <p style={{ margin: 0, fontWeight: 620 }}>{SENTIMENT_LABEL_TEXT[summary.label]}</p>
        {summary.classified > 0 ? (
          <ul className="legend">
            {SENTIMENT_KEYS.map((key) => (
              <li key={key}>
                <span className="swatch" style={{ background: KEY_COLOR[key] }} aria-hidden="true" />
                <span>{KEY_TEXT[key]}</span>
                <span className="value">
                  {summary.counts[key]} · {Math.round((summary.counts[key] / summary.classified) * 100)}%
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="subtle" style={{ margin: 0 }}>
          {summary.classified} classified of {summary.contentItems} posts or videos from {summary.uniqueAccounts}{" "}
          {summary.uniqueAccounts === 1 ? "account" : "accounts"}, {window}.
          {summary.unknown > 0 ? ` ${summary.unknown} could not be classified and are not counted in the shares.` : ""}{" "}
          Unweighted: one vote per post, from content resolved to this exact printing. Excluded creators are left out.
          {summary.classified > 0 && summary.classified < SENTIMENT_MIN_SAMPLE
            ? ` Fewer than ${SENTIMENT_MIN_SAMPLE} posts is too few to call a direction.`
            : ""}
        </p>
      </figcaption>
    </figure>
  );
}
