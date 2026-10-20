/**
 * Illustrations for the public landing page. Every figure here is example data
 * drawn to show what the product looks like; each block carries a visible
 * "Example" label so nobody reads it as a live market reading. Card faces are
 * drawn foil frames rather than real artwork, which the catalog does not carry.
 */

type Point = { x: number; y: number };

function scale(
  values: number[],
  width: number,
  height: number,
  pad = 4,
): Point[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = (width - pad * 2) / (values.length - 1);
  return values.map((value, index) => ({
    x: pad + index * step,
    y: pad + (height - pad * 2) * (1 - (value - min) / span),
  }));
}

function linePath(points: Point[]): string {
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");
}

function areaPath(points: Point[], height: number): string {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return `${linePath(points)} L${last.x.toFixed(1)},${height} L${first.x.toFixed(1)},${height} Z`;
}

/** 90 daily closes for the hero card: a slow base, a dip, then a run after the first buy calls. */
const HERO_SERIES = [
  212, 210, 213, 209, 207, 208, 205, 206, 204, 203, 205, 202, 200, 201, 199,
  198, 200, 197, 196, 198, 195, 194, 196, 193, 192, 194, 191, 193, 195, 194,
  197, 199, 198, 201, 203, 202, 206, 209, 208, 212, 215, 214, 218, 221, 219,
  224, 227, 226, 230, 233, 231, 236, 239, 237, 241, 244, 242, 246, 249, 247,
  251, 253, 250, 254, 257, 255, 258, 261, 259, 262, 260, 263, 266, 264, 267,
  265, 268, 271, 269, 272, 270, 273, 276, 274, 277, 275, 278, 281, 279, 284,
];

/** Days in HERO_SERIES where a tracked creator made a call, and whether it came true. */
const HERO_CALLS = [
  { day: 24, side: "buy", hit: true },
  { day: 33, side: "buy", hit: true },
  { day: 47, side: "sell", hit: false },
  { day: 58, side: "buy", hit: true },
] as const;

/** Real card pictures for the landing page, looked up from the catalog when it is reachable. */
export type LandingImage = { src: string; alt: string };
export type LandingImages = Partial<Record<LandingImageKey, LandingImage>>;
export type LandingImageKey = "heroCenter" | "heroLeft" | "heroRight" | "blueEyes" | "goku";

/** Catalog cards to picture; any that are missing keep the drawn frame. */
export const LANDING_IMAGE_PICKS: { key: LandingImageKey; gameKey: string; cardName: string; setName?: string }[] = [
  { key: "heroCenter", gameKey: "pokemon", cardName: "Charizard ex", setName: "Obsidian Flames" },
  { key: "heroLeft", gameKey: "one_piece", cardName: "Monkey.D.Luffy" },
  { key: "heroRight", gameKey: "yugioh", cardName: "Blue-Eyes White Dragon" },
  { key: "blueEyes", gameKey: "yugioh", cardName: "Blue-Eyes White Dragon" },
  { key: "goku", gameKey: "dragon_ball", cardName: "Son Goku" },
];

function CardPhoto({ image, className }: { image: LandingImage; className?: string }) {
  return (
    // Card pictures come from several catalog hosts and are already sized.
    <img className={className} src={image.src} alt={image.alt} decoding="async" referrerPolicy="no-referrer" />
  );
}

function HoloCard({
  tone,
  className,
  image,
}: {
  tone: "gold" | "violet" | "ember";
  className: string;
  image?: LandingImage;
}) {
  if (image) {
    return (
      <div className={`holo-card holo-photo-card ${className}`}>
        <CardPhoto image={image} className="holo-photo" />
      </div>
    );
  }
  return (
    <div className={`holo-card holo-${tone} ${className}`} aria-hidden="true">
      <div className="holo-frame">
        <span className="holo-name" />
        <span className="holo-window" />
        <span className="holo-text" />
        <span className="holo-text short" />
      </div>
    </div>
  );
}

export function HeroPreview({ images = {} }: { images?: LandingImages }) {
  const width = 320;
  const height = 120;
  const points = scale(HERO_SERIES, width, height);
  const meter = 74;
  return (
    <figure
      className="hero-visual"
      aria-label="Example of a Sentiment card reading"
    >
      <div className="hero-cards">
        <HoloCard tone="violet" className="fan-left" image={images.heroLeft} />
        <HoloCard tone="ember" className="fan-right" image={images.heroRight} />
        <HoloCard tone="gold" className="fan-center" image={images.heroCenter} />
      </div>
      <div className="hero-panel">
        <div className="hero-panel-top">
          <div>
            <p className="hero-panel-name">
              Charizard ex · Special Illustration Rare
            </p>
            <p className="hero-panel-meta">
              Raw, near mint · sold prices, last 90 days
            </p>
          </div>
          <span className="example-tag">Example</span>
        </div>
        <div className="hero-price">
          <strong>$284</strong>
          <span className="trend-up">▲ 48% since the first buy call</span>
        </div>
        <svg
          className="hero-chart"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="Price rising from about $192 to $284 over 90 days, with three correct buy calls and one missed sell call"
        >
          {[0.25, 0.5, 0.75].map((f) => (
            <line
              key={f}
              x1="0"
              x2={width}
              y1={height * f}
              y2={height * f}
              className="chart-gridline"
            />
          ))}
          <path d={areaPath(points, height)} className="chart-fill-up" />
          <path d={linePath(points)} className="chart-stroke-up" />
          {HERO_CALLS.map((call) => {
            const p = points[call.day]!;
            return (
              <g key={call.day} className={call.hit ? "call-hit" : "call-miss"}>
                <line
                  x1={p.x}
                  x2={p.x}
                  y1={p.y}
                  y2={height}
                  className="call-stem"
                />
                <circle cx={p.x} cy={p.y} r="5" />
              </g>
            );
          })}
        </svg>
        <ul className="hero-legend">
          <li>
            <span className="dot call-hit" /> Call came true
          </li>
          <li>
            <span className="dot call-miss" /> Call missed
          </li>
        </ul>
        <div
          className="buy-meter"
          role="img"
          aria-label={`Market sentiment ${meter} out of 100, leaning buy`}
        >
          <div className="buy-meter-labels">
            <span>Sell</span>
            <strong>Buy · {meter}</strong>
          </div>
          <div className="buy-meter-track">
            <span className="buy-meter-mark" style={{ left: `${meter}%` }} />
          </div>
          <p className="buy-meter-note">
            From 38 calls by 12 creators, weighted by their track record
          </p>
        </div>
      </div>
    </figure>
  );
}

type Mover = {
  name: string;
  kind: string;
  change: number;
  reading: "Buy" | "Sell" | "Hold";
  series: number[];
  /** A single card's tile shows its picture when the catalog has one. */
  imageKey?: LandingImageKey;
};

const MOVERS: Mover[] = [
  {
    name: "Prismatic Evolutions",
    kind: "Pokémon · set",
    change: 22,
    reading: "Buy",
    series: [
      100, 101, 99, 102, 104, 103, 106, 108, 107, 111, 113, 112, 115, 118, 117,
      120, 122,
    ],
  },
  {
    name: "Romance Dawn booster box",
    kind: "One Piece · sealed",
    change: 15,
    reading: "Buy",
    series: [
      100, 99, 101, 100, 102, 104, 103, 105, 107, 106, 109, 110, 112, 111, 113,
      114, 115,
    ],
  },
  {
    name: "Blue-Eyes White Dragon PSA 10",
    imageKey: "blueEyes",
    kind: "Yu-Gi-Oh! · graded",
    change: -9,
    reading: "Sell",
    series: [
      100, 101, 100, 99, 100, 98, 97, 98, 96, 95, 96, 94, 93, 94, 92, 91, 91,
    ],
  },
  {
    name: "Son Goku, Fusion World leader",
    imageKey: "goku",
    kind: "Dragon Ball · card",
    change: -14,
    reading: "Sell",
    series: [
      100, 99, 100, 97, 96, 97, 94, 93, 94, 91, 90, 91, 89, 88, 87, 87, 86,
    ],
  },
];

function MoverTile({ mover, image }: { mover: Mover; image?: LandingImage }) {
  const width = 200;
  const height = 56;
  const points = scale(mover.series, width, height, 3);
  const up = mover.change >= 0;
  return (
    <li className={image ? "mover has-photo" : "mover"}>
      {image ? <CardPhoto image={image} className="mover-photo" /> : null}
      <div className="mover-head">
        <span className="mover-kind">{mover.kind}</span>
        <span className={`reading reading-${mover.reading.toLowerCase()}`}>
          {mover.reading}
        </span>
      </div>
      <p className="mover-name">{mover.name}</p>
      <p className={up ? "trend-up" : "trend-down"}>
        {up ? "▲" : "▼"} {Math.abs(mover.change)}% in 30 days
      </p>
      <svg
        className="mover-chart"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path
          d={areaPath(points, height)}
          className={up ? "chart-fill-up" : "chart-fill-down"}
        />
        <path
          d={linePath(points)}
          className={up ? "chart-stroke-up" : "chart-stroke-down"}
        />
      </svg>
    </li>
  );
}

export function MarketMovers({ images = {} }: { images?: LandingImages }) {
  return (
    <ul className="movers" aria-label="Example market movers">
      {MOVERS.map((mover) => (
        <MoverTile key={mover.name} mover={mover} image={mover.imageKey ? images[mover.imageKey] : undefined} />
      ))}
    </ul>
  );
}

const CREATORS = [
  { name: "Channel A", reach: "1.2M subscribers", hit: 71, calls: 64 },
  { name: "Channel B", reach: "84K subscribers", hit: 66, calls: 41 },
  { name: "Forum regular C", reach: "Reddit, 9K karma", hit: 58, calls: 27 },
  { name: "Channel D", reach: "2.6M subscribers", hit: 34, calls: 88 },
];

export function CreatorBoard() {
  return (
    <div className="board">
      <div className="board-head">
        <span>Creator</span>
        <span>Calls that came true</span>
        <span className="example-tag">Example</span>
      </div>
      <ol className="board-rows">
        {CREATORS.map((creator) => (
          <li
            key={creator.name}
            className={creator.hit < 50 ? "board-row weak" : "board-row"}
          >
            <div>
              <p className="board-name">{creator.name}</p>
              <p className="board-reach">
                {creator.reach} · {creator.calls} calls scored
              </p>
            </div>
            <div
              className="board-bar"
              role="img"
              aria-label={`${creator.hit}% of calls came true`}
            >
              <span style={{ width: `${creator.hit}%` }} />
            </div>
            <strong className="board-pct">{creator.hit}%</strong>
          </li>
        ))}
      </ol>
      <p className="board-note">
        The biggest channel has the weakest record, so its calls count for the
        least.
      </p>
    </div>
  );
}
