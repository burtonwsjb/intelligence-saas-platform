import { Badge, StatusBadge } from "@/components/Badge";
import { CardArt } from "@/components/CardArt";
import { ScoreRing } from "@/components/ScoreRing";
import { Sparkline } from "@/components/Sparkline";
import {
  CONFIRMATION_TEXT,
  conditionText,
  formatChange,
  languageText,
  priceFreshness,
  recommendationText,
  variantText,
} from "@/lib/display";
import { SENTIMENT_LABEL_TEXT, marketConfirmationState, type ExplorerRow } from "@isp/db";
import { formatMoney } from "@isp/shared";
import Link from "next/link";

/**
 * Reading order: artwork and exact identity, then price, then one opportunity
 * ring with sentiment, freshness and a single evidence sentence. Full
 * risk/confidence/liquidity breakdowns live on the detail page.
 */
export function CardTile({ row, href, windowLabel }: { row: ExplorerRow; href: string; windowLabel: string }) {
  const change = formatChange(row.windowChange);
  const freshness = priceFreshness(row.price?.observedAt);
  const confirmation = CONFIRMATION_TEXT[marketConfirmationState(row.score)];
  const lowConfidence = row.score != null && row.score.confidence < 40;
  const highRisk = row.score != null && row.score.risk >= 60;
  return (
    <article className="card-tile">
      <div className="card-art">
        <CardArt cardName={row.cardName} setName={row.setName} collectorNumber={row.collectorNumber} />
        <div className="card-badges">
          <Badge tone="solid">{languageText(row.languageCode)}</Badge>
          <Badge tone="solid">{variantText(row.variantKey)}</Badge>
        </div>
      </div>
      <div className="card-body">
        <h3 className="card-title">
          <Link href={href}>{row.cardName}</Link>
        </h3>
        <p className="card-meta">
          {row.setName} · #{row.collectorNumber}
          {row.rarity ? ` · ${row.rarity}` : ""}
        </p>
        <div className="card-price-row">
          <div className="card-price">
            {row.price ? (
              <>
                <span className="amount">{formatMoney(row.price.amount, row.price.currency)}</span>
                <span className="quote">
                  Last sold · {conditionText(row.price.condition)} · {row.price.currency}
                </span>
                {change ? (
                  <span className={`change ${change.direction}`}>
                    {change.text} <span className="subtle">{windowLabel}</span>
                  </span>
                ) : (
                  <span className="subtle">No {windowLabel} comparison</span>
                )}
              </>
            ) : (
              <>
                <span className="amount" style={{ color: "var(--ink-3)" }}>
                  No price
                </span>
                <span className="quote">No valid sale on record</span>
              </>
            )}
          </div>
          {row.series.length >= 2 ? (
            <Sparkline values={row.series.map((point) => point.amount)} label={`${windowLabel} sold price trend`} />
          ) : null}
        </div>
        <div className="card-signal">
          <ScoreRing kind="opportunity" value={row.score?.opportunity} size="sm" caption={false} />
          <div className="card-signal-text">
            <strong>{row.score ? recommendationText(row.score.recommendation) : "Not scored yet"}</strong>
            <span className="subtle">Social: {SENTIMENT_LABEL_TEXT[row.sentiment.label]}</span>
          </div>
        </div>
        <div className="badge-row">
          <StatusBadge tone={freshness.tone} label={freshness.label} />
          {row.score ? <StatusBadge tone={confirmation.tone} label={confirmation.label} /> : null}
          {highRisk ? <StatusBadge tone="warn" label={`Risk ${Math.round(row.score!.risk)}`} /> : null}
          {lowConfidence ? <StatusBadge tone="warn" label="Low confidence" /> : null}
        </div>
        {row.score?.why ? <p className="card-why">Why: {row.score.why}</p> : null}
      </div>
    </article>
  );
}
