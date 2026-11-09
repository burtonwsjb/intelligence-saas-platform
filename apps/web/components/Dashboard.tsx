import { CardArt } from "@/components/CardArt";
import { Icon, type IconName } from "@/components/Icon";
import { Sparkline } from "@/components/Sparkline";
import { formatChange, gameText, recommendationText } from "@/lib/display";
import type { ExplorerRow } from "@isp/db";
import { formatMoney } from "@isp/shared";
import Link from "next/link";
import type { ReactNode } from "react";

/** Which side of the buy/sell scale a stored recommendation sits on. */
export function signalSide(recommendation: string | null | undefined): "buy" | "sell" | "hold" | "none" {
  if (!recommendation || recommendation === "insufficient_data") return "none";
  if (recommendation === "strong_buy" || recommendation === "buy") return "buy";
  if (recommendation === "strong_sell" || recommendation === "sell" || recommendation === "reduce") return "sell";
  return "hold";
}

export function SignalPill({ recommendation }: { recommendation: string | null | undefined }) {
  const side = signalSide(recommendation);
  const icon: IconName | null = side === "buy" ? "arrowUp" : side === "sell" ? "arrowDown" : null;
  return (
    <span className={`signal-pill ${side}`}>
      {icon ? <Icon name={icon} size={12} /> : null}
      {side === "none" ? "Not scored" : recommendationText(recommendation)}
    </span>
  );
}

/** A dashboard number tile: icon, label, big value, optional note and link. */
export function KpiTile({
  icon,
  tone = "accent",
  label,
  value,
  note,
  href,
}: {
  icon: IconName;
  tone?: "accent" | "buy" | "sell" | "neutral";
  label: string;
  value: ReactNode;
  note?: ReactNode;
  href?: string;
}) {
  const body = (
    <>
      <span className={`kpi-icon ${tone}`}>
        <Icon name={icon} size={18} />
      </span>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {note ? <span className="kpi-note">{note}</span> : null}
    </>
  );
  return href ? (
    <Link className="kpi" href={href}>
      {body}
    </Link>
  ) : (
    <div className="kpi">{body}</div>
  );
}

/** Buy / hold / sell split of every scored card, as one labeled bar. */
export function MarketPulse({ buy, hold, sell }: { buy: number; hold: number; sell: number }) {
  const total = buy + hold + sell;
  const pct = (n: number) => (total === 0 ? 0 : Math.round((n / total) * 1000) / 10);
  const lean = total === 0 ? "No scored cards yet" : buy > sell * 1.15 ? "Leaning buy" : sell > buy * 1.15 ? "Leaning sell" : "Balanced";
  const leanTone = total === 0 ? "none" : buy > sell * 1.15 ? "buy" : sell > buy * 1.15 ? "sell" : "hold";
  const segments = [
    { key: "buy", label: "Buy", count: buy, href: "/app/cards?market=buy&sort=market_buy" },
    { key: "hold", label: "Hold / watch", count: hold, href: "/app/cards?market=hold" },
    { key: "sell", label: "Sell", count: sell, href: "/app/cards?market=sell&sort=market_sell" },
  ] as const;
  return (
    <section className="dash-card pulse" aria-labelledby="pulse-heading">
      <div className="dash-card-head">
        <div>
          <h2 id="pulse-heading">Market pulse</h2>
          <p className="subtle">How every scored card reads right now</p>
        </div>
        <span className={`signal-pill ${leanTone}`}>{lean}</span>
      </div>
      <div className="pulse-bar" role="img" aria-label={`Buy ${buy}, hold ${hold}, sell ${sell}`}>
        {total === 0 ? (
          <span className="pulse-empty" />
        ) : (
          segments.map((segment) =>
            segment.count > 0 ? (
              <span key={segment.key} className={`pulse-seg ${segment.key}`} style={{ flexGrow: segment.count }} />
            ) : null,
          )
        )}
      </div>
      <ul className="pulse-legend">
        {segments.map((segment) => (
          <li key={segment.key}>
            <Link href={segment.href}>
              <span className={`pulse-dot ${segment.key}`} aria-hidden="true" />
              <span className="pulse-legend-label">{segment.label}</span>
              <strong>{segment.count.toLocaleString("en-US")}</strong>
              <span className="subtle">{pct(segment.count)}%</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A compact ranked list of cards: thumbnail, identity, price and reading. */
export function SignalList({
  rows,
  empty,
  windowLabel = "30d",
}: {
  rows: ExplorerRow[];
  empty: string;
  windowLabel?: string;
}) {
  if (rows.length === 0) {
    return <p className="signal-empty">{empty}</p>;
  }
  return (
    <ol className="signal-list">
      {rows.map((row) => {
        const change = formatChange(row.windowChange);
        return (
          <li key={row.printingId}>
            <Link className="signal-row" href={`/app/cards/${encodeURIComponent(row.printingId)}`}>
              <span className="signal-thumb">
                <CardArt cardName={row.cardName} setName={row.setName} collectorNumber={row.collectorNumber} imageUrl={row.imageUrl} />
              </span>
              <span className="signal-id">
                <strong>{row.cardName}</strong>
                <span className="subtle">
                  {gameText(row.gameKey)} · {row.setName} · #{row.collectorNumber}
                </span>
              </span>
              <span className={`signal-spark ${change?.direction ?? ""}`}>
                {row.series.length >= 2 ? (
                  <Sparkline values={row.series.map((point) => point.amount)} label={`${windowLabel} price trend`} />
                ) : null}
              </span>
              <span className="signal-price">
                <strong>{row.price ? formatMoney(row.price.amount, row.price.currency) : "—"}</strong>
                {change ? <span className={`change ${change.direction}`}>{change.text}</span> : <span className="subtle">No {windowLabel} change</span>}
              </span>
              <SignalPill recommendation={row.score?.recommendation} />
            </Link>
          </li>
        );
      })}
    </ol>
  );
}

export function QuickLink({ href, icon, title, body }: { href: string; icon: IconName; title: string; body: string }) {
  return (
    <Link className="quick-link" href={href}>
      <span className="quick-link-icon">
        <Icon name={icon} />
      </span>
      <span>
        <strong>{title}</strong>
        <span className="subtle">{body}</span>
      </span>
      <Icon name="arrowRight" size={16} className="quick-link-arrow" />
    </Link>
  );
}
