import { Badge } from "@/components/Badge";
import { EmptyState } from "@/components/EmptyState";
import { confidenceLabel, type ChartSentimentSegmentView, type PrintingChartSentiment } from "@isp/db";

const LABEL_TEXT = {
  bullish: { text: "Bullish", icon: "▲", tone: "good" },
  neutral: { text: "Neutral", icon: "●", tone: "info" },
  bearish: { text: "Bearish", icon: "▼", tone: "bad" },
} as const;

/** "Raw (ungraded)", "PSA 10", "BGS 9.5". */
export function chartSegmentName(view: Pick<ChartSentimentSegmentView, "segment" | "gradingCompany" | "grade">): string {
  if (view.segment === "raw") return "Raw (ungraded)";
  const company = (view.gradingCompany ?? "graded").toUpperCase();
  return view.grade ? `${company} ${view.grade}` : company;
}

function scoreText(score: number) {
  return score > 0 ? `+${score}` : String(score);
}

function Segment({ view }: { view: ChartSentimentSegmentView }) {
  const name = chartSegmentName(view);
  if (view.label === "insufficient_history" || view.score == null) {
    return (
      <li>
        <span className="item-main">
          <strong>{name}</strong>
          <span className="subtle">
            Not enough price history yet: {view.points} daily point{view.points === 1 ? "" : "s"}
            {view.dataThrough ? ` through ${view.dataThrough}` : ""}; a chart reading needs at least 30.
          </span>
        </span>
        <Badge>Insufficient history</Badge>
      </li>
    );
  }
  const label = LABEL_TEXT[view.label];
  const top = view.signals.slice(0, 3);
  return (
    <li style={{ display: "grid", gap: "var(--space-2)", justifyContent: "stretch" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-3)" }}>
        <span className="item-main">
          <strong>{name}</strong>
          <span className="subtle">
            {view.points} daily {view.priceType === "sold" ? "sale" : "reference"} prices through {view.dataThrough} ·{" "}
            {confidenceLabel(view.confidence)} confidence
          </span>
        </span>
        <Badge tone={label.tone} title={`Chart score ${scoreText(view.score)} on a -100 to +100 scale`}>
          <span aria-hidden="true">{label.icon}</span> {label.text} {scoreText(view.score)}
        </Badge>
      </div>
      {top.length === 0 ? (
        <p className="subtle" style={{ margin: 0 }}>
          No chart pattern is active right now.
        </p>
      ) : (
        <ul className="drivers">
          {top.map((signal) => (
            <li key={signal.key}>
              <strong>
                {signal.direction === "bullish" ? "▲" : "▼"} {signal.name}
              </strong>{" "}
              · {signal.detail}
              <br />
              <span className="subtle">
                {signal.explanation} Right {Math.round(signal.hitRate * 100)}% of the time over {signal.horizonDays} days
                {signal.samples > 0 ? ` (${signal.samples} measured cases)` : " (prior; not yet measured on our cards)"}.
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * What the charts say, kept apart from what people say: one row per segment
 * (raw first, then each grade), each with its score badge and top 3 signals.
 */
export function ChartSentimentPanel({ chart }: { chart: PrintingChartSentiment | undefined }) {
  const segments = chart ? [...(chart.raw ? [chart.raw] : []), ...chart.graded] : [];
  return (
    <section className="panel">
      <h2>Chart sentiment</h2>
      {segments.length === 0 ? (
        <EmptyState
          title="Not computed yet"
          body="Chart sentiment is computed daily from stored price history. It appears once this printing has prices on record."
        />
      ) : (
        <ul className="item-list">
          {segments.map((view) => (
            <Segment key={view.segment} view={view} />
          ))}
        </ul>
      )}
      <p className="notice info">
        Chart sentiment reads price, sales, listings and graded population history with standard chart rules (moving
        averages, RSI, MACD, support and resistance, double tops and bottoms, head and shoulders, Bollinger bands). Raw and
        each grade are read separately. It is an educated guess from past patterns, not a forecast or investment advice.
      </p>
    </section>
  );
}
