import { formatDate, timeSeriesGeometry, type Point } from "@/lib/display";
import { formatMoney } from "@isp/shared";

/**
 * One comparable price series (one currency, one condition, one quote type).
 * Points sit at their observation time; every point has a native tooltip and
 * the same values are available as a table.
 */
export function PriceTrendChart({
  points,
  currency,
  title,
  caption,
}: {
  points: Point[];
  /** Money series carry their currency; omit it for unitless series such as index levels. */
  currency?: string;
  title: string;
  caption?: string;
}) {
  const geometry = timeSeriesGeometry(points);
  const format = (value: number) => (currency ? formatMoney(value, currency) : value.toFixed(2));
  if (!geometry || points.length < 2) {
    return (
      <div className="empty-state">
        <p>
          <strong>Not enough price history to chart</strong>
        </p>
        <p className="muted">
          {points.length === 1
            ? "Only one observation is on record. A trend needs at least two."
            : "No comparable observations are on record yet."}
        </p>
      </div>
    );
  }
  const { plot } = geometry;
  return (
    <figure className="chart" style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${geometry.width} ${geometry.height}`} role="img" aria-label={`${title}, ${points.length} observations`}>
        {geometry.yTicks.map((tick) => (
          <g key={tick.y}>
            <line className="grid-line" x1={plot.left} x2={plot.right} y1={tick.y} y2={tick.y} />
            <text className="axis-label" x={plot.left - 8} y={tick.y} textAnchor="end" dominantBaseline="central">
              {format(tick.value)}
            </text>
          </g>
        ))}
        <text className="axis-label" x={plot.left} y={geometry.height - 6} textAnchor="start">
          {formatDate(geometry.domain.from)}
        </text>
        <text className="axis-label" x={plot.right} y={geometry.height - 6} textAnchor="end">
          {formatDate(geometry.domain.to)}
        </text>
        {geometry.area ? <path className="series-area" d={geometry.area} /> : null}
        <path className="series-line" d={geometry.line} />
        {geometry.points.map((point, index) => (
          <g key={`${point.x}-${index}`}>
            <circle className="hit" cx={point.x} cy={point.y} r={10} tabIndex={-1}>
              <title>{`${formatDate(point.observedAt)} · ${format(point.amount)}`}</title>
            </circle>
            <circle className="series-point" cx={point.x} cy={point.y} r={geometry.points.length > 40 ? 2.5 : 4} />
          </g>
        ))}
      </svg>
      {caption ? <figcaption className="chart-caption">{caption}</figcaption> : null}
      <details className="technical-details">
        <summary>View as table</summary>
        <div className="table-wrap">
          <table className="data-table">
            <caption className="visually-hidden">{title}</caption>
            <thead>
              <tr>
                <th scope="col">Observed</th>
                <th scope="col" className="num">
                  {currency ? `Price (${currency})` : "Value"}
                </th>
              </tr>
            </thead>
            <tbody>
              {[...points]
                .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())
                .slice(0, 60)
                .map((point, index) => (
                  <tr key={index}>
                    <td>{point.observedAt.toISOString().replace("T", " ").slice(0, 16)} UTC</td>
                    <td className="num">{format(point.amount)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
