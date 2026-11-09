import { Badge, StatusBadge } from "@/components/Badge";
import { CardArt } from "@/components/CardArt";
import { SignalPill } from "@/components/Dashboard";
import { Sparkline } from "@/components/Sparkline";
import {
  CONFIRMATION_TEXT,
  conditionText,
  formatChange,
  socialText,
  languageText,
  priceFreshness,
  quoteText,
  variantText,
} from "@/lib/display";
import { marketConfirmationState, type ExplorerRow } from "@isp/db";
import { formatMoney } from "@isp/shared";
import Link from "next/link";

/**
 * Reading order: artwork with the buy/sell reading, exact identity, price and
 * trend, then one opportunity meter. Badges appear only when something needs
 * attention (stale price, high risk, low confidence); the full breakdown lives
 * on the detail page.
 */
export function CardTile({ row, href, windowLabel }: { row: ExplorerRow; href: string; windowLabel: string }) {
  const change = formatChange(row.windowChange);
  const freshness = priceFreshness(row.price?.observedAt);
  const confirmation = CONFIRMATION_TEXT[marketConfirmationState(row.score)];
  // Without a reading the stored opportunity is the neutral midpoint, not a measurement: show no number.
  const hasReading = row.score != null && row.score.recommendation !== "insufficient_data";
  const opportunity = hasReading && row.score!.opportunityMeasured ? Math.round(row.score!.opportunity) : null;
  const lowConfidence = hasReading && row.score!.confidence < 40;
  const highRisk = hasReading && row.score!.risk >= 60;
  const social = socialText(row.sentiment);
  const warnings = [
    freshness.tone === "warn" ? { tone: "warn" as const, label: freshness.label } : null,
    row.score && confirmation.tone === "warn" ? { tone: "warn" as const, label: confirmation.label } : null,
    highRisk ? { tone: "warn" as const, label: `Risk ${Math.round(row.score!.risk)}` } : null,
    lowConfidence ? { tone: "warn" as const, label: "Low confidence" } : null,
  ].filter((value): value is { tone: "warn"; label: string } => value != null);
  return (
    <article className="card-tile">
      <div className="card-art">
        <CardArt
          cardName={row.cardName}
          setName={row.setName}
          collectorNumber={row.collectorNumber}
          imageUrl={row.imageUrl}
        />
        <div className="card-badges">
          <Badge tone="solid">{languageText(row.languageCode)}</Badge>
          {row.variantKey !== "normal" ? <Badge tone="solid">{variantText(row.variantKey)}</Badge> : null}
        </div>
        <div className="card-signal-corner">
          <SignalPill recommendation={row.score?.recommendation} />
        </div>
      </div>
      <div className="card-body">
        <div>
          <h3 className="card-title">
            <Link href={href}>{row.cardName}</Link>
          </h3>
          <p className="card-meta">
            {row.setName} · #{row.collectorNumber}
            {row.rarity ? ` · ${row.rarity}` : ""}
          </p>
        </div>
        <div className="card-price-row">
          <div className="card-price">
            {row.price ? (
              <>
                <span className="amount">{formatMoney(row.price.amount, row.price.currency)}</span>
                <span className="quote">
                  {change ? (
                    <span className={`change ${change.direction}`}>{change.text}</span>
                  ) : null}{" "}
                  {change ? windowLabel : `No ${windowLabel} change`} · {quoteText(row.price.quoteType)}
                  {row.price.quoteType === "sold" ? ` · ${conditionText(row.price.condition)}` : ""}
                </span>
              </>
            ) : (
              <>
                <span className="amount muted-amount">No price</span>
                <span className="quote">No sale or market price yet</span>
              </>
            )}
          </div>
          {row.series.length >= 2 ? (
            <span className={`card-spark ${change?.direction ?? ""}`}>
              <Sparkline values={row.series.map((point) => point.amount)} label={`${windowLabel} ${row.price?.quoteType === "sold" ? "sold" : "market"} price trend`} />
            </span>
          ) : null}
        </div>
        <div className="card-meter">
          <span className="card-meter-label">Opportunity</span>
          <span className="card-meter-track" aria-hidden="true">
            {opportunity != null ? <span className="card-meter-fill" style={{ width: `${opportunity}%` }} /> : null}
          </span>
          <strong className="card-meter-value">{opportunity ?? "—"}</strong>
        </div>
        {row.sentiment.classified > 0 ? <p className="card-social">Social: {social}</p> : null}
        {warnings.length > 0 ? (
          <div className="badge-row">
            {warnings.map((warning) => (
              <StatusBadge key={warning.label} tone={warning.tone} label={warning.label} />
            ))}
          </div>
        ) : null}
        {row.score?.why ? <p className="card-why">{row.score.why}</p> : null}
      </div>
    </article>
  );
}
