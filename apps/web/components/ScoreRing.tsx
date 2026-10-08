import { formatScore } from "@/lib/display";

export type ScoreKind = "opportunity" | "risk" | "confidence" | "liquidity";

const LABEL: Record<ScoreKind, string> = {
  opportunity: "Opportunity",
  risk: "Risk",
  confidence: "Confidence",
  liquidity: "Liquidity",
};

// What each scale means, shown under the large rings so a number is never read as a probability.
const CAPTION: Record<ScoreKind, string> = {
  opportunity: "Score out of 100, not a chance of profit",
  risk: "Higher means more risk",
  confidence: "How much evidence backs the score",
  liquidity: "How easily it trades, from sales and listings",
};

export function ScoreRing({
  kind,
  value,
  size = "lg",
  caption,
}: {
  kind: ScoreKind;
  value: number | null | undefined;
  size?: "sm" | "lg";
  caption?: string | false;
}) {
  const px = size === "sm" ? 52 : 104;
  const stroke = size === "sm" ? 5 : 8;
  const r = px / 2 - stroke / 2 - 1;
  const circumference = 2 * Math.PI * r;
  const has = value != null && Number.isFinite(value);
  const clamped = has ? Math.min(100, Math.max(0, value)) : 0;
  const label = LABEL[kind];
  const text = has ? `${label} ${formatScore(value)} out of 100` : `${label}: no score`;
  const shownCaption = caption === false ? null : (caption ?? (size === "lg" ? CAPTION[kind] : null));
  return (
    <figure className={`score-ring ${kind}`} style={{ margin: 0 }}>
      <svg width={px} height={px} viewBox={`0 0 ${px} ${px}`} role="img" aria-label={text}>
        <circle
          className={has ? "ring-track" : "ring-empty"}
          cx={px / 2}
          cy={px / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
        />
        {has ? (
          <circle
            className="ring-value"
            cx={px / 2}
            cy={px / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - clamped / 100)}
            transform={`rotate(-90 ${px / 2} ${px / 2})`}
          />
        ) : null}
        <text
          className={has ? "ring-number" : "ring-missing"}
          x="50%"
          y="50%"
          dominantBaseline="central"
          textAnchor="middle"
          fontSize={has ? (size === "sm" ? 16 : 28) : size === "sm" ? 10 : 13}
        >
          {has ? formatScore(value) : size === "sm" ? "—" : "No score"}
        </text>
      </svg>
      <figcaption>
        <span className="score-ring-label">{label}</span>
        {shownCaption ? <span className="score-ring-caption"> · {shownCaption}</span> : null}
      </figcaption>
    </figure>
  );
}
