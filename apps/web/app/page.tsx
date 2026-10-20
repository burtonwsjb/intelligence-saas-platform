import Link from "next/link";
import { redirect } from "next/navigation";
import {
  CreatorBoard,
  HeroPreview,
  LANDING_IMAGE_PICKS,
  MarketMovers,
  type LandingImages,
} from "@/components/LandingVisuals";
import { getDb, tryGetAuth } from "@/lib/auth";
import { getOptionalSession } from "@/lib/session";
import { findCardImages } from "@isp/db";

export const dynamic = "force-dynamic";

const GAMES = ["Pokémon", "One Piece", "Dragon Ball", "Yu-Gi-Oh!"];

const STEPS = [
  {
    title: "Track a topic",
    body: "Enter a set, a card or a sealed product. Sentiment searches YouTube, Reddit, creator sites and Google for the people talking about it. No channel lists to maintain.",
  },
  {
    title: "Score every call",
    body: "When a creator says a card will rise or fall, the call is recorded with the price at that moment and checked against real sold prices 30 days later.",
  },
  {
    title: "Read the sentiment",
    body: "Each card, set, sealed and graded product gets a buy or sell reading. Creators with a strong track record count for more; creators you drop count for nothing.",
  },
];

const PRINCIPLES = [
  {
    title: "Popularity is not accuracy",
    body: "Reach and track record are measured separately. A big channel with a poor record is weighted down.",
  },
  {
    title: "Sales confirm the story",
    body: "Hype alone never drives a score. Every reading shows whether sold prices from TCG Card Central back it up.",
  },
  {
    title: "Every number shows its work",
    body: "Open any card to see the calls, posts and sales behind it, how fresh they are, and how much evidence there is.",
  },
];

/** Real card pictures for the showcase spots; drawn frames stand in when there is no catalog. */
async function landingImages(): Promise<LandingImages> {
  if (!tryGetAuth()) {
    return {};
  }
  try {
    const found = await findCardImages(getDb(), LANDING_IMAGE_PICKS);
    const images: LandingImages = {};
    for (const pick of LANDING_IMAGE_PICKS) {
      const image = found.get(pick.key);
      if (image) {
        images[pick.key] = { src: image.imageUrl, alt: `${image.cardName}, ${image.setName}` };
      }
    }
    return images;
  } catch {
    return {};
  }
}

/**
 * Public landing page. Signed-in visitors go straight to their briefing, so the
 * pitch is only ever shown to people who have not started yet.
 */
export default async function HomePage() {
  const session = await getOptionalSession();
  if (session) {
    redirect("/app");
  }
  const images = await landingImages();
  return (
    <div className="landing">
      <section className="landing-hero" aria-labelledby="hero-heading">
        <div className="landing-hero-copy">
          <p className="eyebrow">Trading card market sentiment</p>
          <h1 id="hero-heading">
            Know which calls to trust before the price moves.
          </h1>
          <p className="landing-lede">
            Sentiment turns what collectors and creators are saying into a buy
            or sell reading for every card, set, sealed box and graded slab,
            weighted by whose calls actually came true.
          </p>
          <div className="landing-actions">
            <Link className="button" href="/signup">
              Start free
            </Link>
            <Link className="button secondary" href="/login">
              Log in
            </Link>
          </div>
          <ul className="landing-games" aria-label="Games covered">
            {GAMES.map((game) => (
              <li key={game}>{game}</li>
            ))}
          </ul>
        </div>
        <HeroPreview images={images} />
      </section>

      <section className="landing-section" aria-labelledby="movers-heading">
        <div className="landing-section-head">
          <h2 id="movers-heading">Spot the moves while they are happening</h2>
          <p>
            Sets, single cards, sealed boxes and graded slabs each get their own
            reading, so a rising set and a falling slab from the same game never
            blur together.
          </p>
        </div>
        <MarketMovers images={images} />
        <p className="landing-example-note">
          Example readings to show the layout, not live market data.
        </p>
      </section>

      <section
        className="landing-section landing-split"
        aria-labelledby="board-heading"
      >
        <div className="landing-section-head">
          <h2 id="board-heading">Follow the creators who get it right</h2>
          <p>
            Every call a creator makes is scored against sold prices. Sentiment
            ranks them by results, not subscribers, and lets you drop anyone
            whose calls you do not trust.
          </p>
        </div>
        <CreatorBoard />
      </section>

      <section className="landing-section" aria-labelledby="how-heading">
        <h2 id="how-heading">How it works</h2>
        <ol className="landing-steps">
          {STEPS.map((step, index) => (
            <li key={step.title} className="landing-card">
              <span className="landing-step-number" aria-hidden="true">
                {index + 1}
              </span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="landing-section" aria-labelledby="trust-heading">
        <h2 id="trust-heading">Built to be trusted</h2>
        <ul className="landing-principles">
          {PRINCIPLES.map((item) => (
            <li key={item.title}>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="landing-cta" aria-labelledby="cta-heading">
        <h2 id="cta-heading">
          See what the market is saying about your cards.
        </h2>
        <Link className="button" href="/signup">
          Create your free workspace
        </Link>
        <p className="subtle">
          Scores describe evidence, not certainty. Sentiment is not investment
          advice.
        </p>
      </section>
    </div>
  );
}
