import { StatusBadge } from "@/components/Badge";
import { VERDICT_STEPS, plural, recommendationText, verdictStep } from "@/lib/display";
import { SENTIMENT_LABEL_TEXT, type ChartSentimentSegmentView, type SentimentSummary } from "@isp/db";
import Link from "next/link";

type Tone = "good" | "warn" | "info" | "bad";

const CHART_TEXT = { bullish: "Bullish", neutral: "Neutral", bearish: "Bearish" } as const;

function socialTone(label: SentimentSummary["label"]): Tone {
  if (label === "mostly_positive" || label === "leaning_positive") return "good";
  if (label === "mostly_negative" || label === "leaning_negative") return "bad";
  return "info";
}

/**
 * The card page's headline answer: one buy/sell reading on a five-step scale,
 * then the three kinds of evidence behind it (what people say, what the chart
 * says, whether sales confirm it), each linking to its detail.
 */
export function SentimentVerdict({
  recommendation,
  uncalibrated,
  social,
  chart,
  confirmation,
  hrefs,
}: {
  recommendation: string | null;
  uncalibrated: boolean;
  social: SentimentSummary;
  chart: ChartSentimentSegmentView | null;
  confirmation: { label: string; tone: Tone };
  hrefs: { sentiment: string; creators: string; market: string };
}) {
  const step = verdictStep(recommendation);
  const chartReady = chart && chart.label !== "insufficient_history" && chart.score != null;
  return (
    <section className="panel verdict" aria-labelledby="verdict-heading">
      <div className="verdict-head">
        <p className="eyebrow" id="verdict-heading">
          Sentiment
        </p>
        <p className="verdict-value">{step == null ? "No reading yet" : recommendationText(recommendation)}</p>
        {step == null ? (
          <p className="subtle" style={{ margin: 0 }}>
            There is not enough evidence on this exact printing to lean either way.
          </p>
        ) : null}
      </div>
      <ol className={`verdict-scale${step == null ? " empty" : ""}`} aria-label="Sell to buy scale">
        {VERDICT_STEPS.map((label, index) => (
          <li key={label} data-step={index} aria-current={index === step ? "true" : undefined}>
            <span className="verdict-bar" aria-hidden="true" />
            <span className="verdict-label">{label}</span>
          </li>
        ))}
      </ol>
      <ul className="verdict-evidence">
        <li>
          <span className="verdict-evidence-name">What people say</span>
          <Link href={hrefs.sentiment}>
            <StatusBadge tone={socialTone(social.label)} label={SENTIMENT_LABEL_TEXT[social.label]} />
          </Link>
          <span className="subtle">
            {social.classified > 0
              ? `${plural(social.classified, "post")} from ${plural(social.uniqueAccounts, "account")}, ${social.ratedPosts.toLocaleString("en-US")} from creators with a track record, last 30 days`
              : "No posts about this printing in the last 30 days"}
          </span>
        </li>
        <li>
          <span className="verdict-evidence-name">What the chart says</span>
          <Link href={hrefs.sentiment}>
            {chartReady ? (
              <StatusBadge
                tone={chart.label === "bullish" ? "good" : chart.label === "bearish" ? "bad" : "info"}
                label={`${CHART_TEXT[chart.label as keyof typeof CHART_TEXT]} ${chart.score! > 0 ? "+" : ""}${chart.score}`}
              />
            ) : (
              <StatusBadge tone="info" label="Not enough history" />
            )}
          </Link>
          <span className="subtle">
            {chartReady
              ? `Raw (ungraded) price chart, ${chart.points} daily prices through ${chart.dataThrough}`
              : "A chart reading needs at least 30 days of prices"}
          </span>
        </li>
        <li>
          <span className="verdict-evidence-name">What sales say</span>
          <Link href={hrefs.market}>
            <StatusBadge tone={confirmation.tone} label={confirmation.label} />
          </Link>
          <span className="subtle">Whether recent sold prices back up the reading</span>
        </li>
      </ul>
      <p className="subtle" style={{ margin: 0 }}>
        {uncalibrated ? "Model not yet calibrated on outcomes. " : ""}A reading of the evidence, not investment advice.{" "}
        <Link className="text-link" href={hrefs.creators}>
          See which creators made calls
        </Link>
      </p>
    </section>
  );
}
