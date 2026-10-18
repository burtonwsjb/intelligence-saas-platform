/**
 * Influencers added by hand after the researched CSV (see
 * pokemon-influencers.ts), kept apart so regenerating that file never drops
 * them. Ranks start at 101 so they never collide with a CSV rank.
 *
 * - 101: PokeInsider (Caleb Nichols), a blog whose posts end with an explicit
 *   call ("My call: BUY"); found through the @pokeinsider1 Instagram bio.
 * - 102–123: the 22 creators mint-take.com lists publicly on its creators
 *   page (2026-10-18). Only their names and the YouTube @handles their
 *   profiles link were taken; none of mint-take's calls or returns. Five of
 *   them (Alpha Investments, Nostalgia Nomics, Phillips Collectibles,
 *   PikaPikaPaPa, Poke Profit) are on the CSV list without a handle, so these
 *   rows are what lets the worker find their channels.
 *
 * Handles are resolved through the YouTube Data API like every other seed;
 * none is guessed. Being on this list is not authority.
 */
import type { InfluencerSeedEntry } from "../seed.js";

export const ADDED_INFLUENCER_SEED_VERSION = "added_influencers.2026-10-18";

const blank = {
  youtubeChannelId: null,
  youtubeHandle: null,
  youtubeUrl: null,
  websiteUrl: null,
  feedUrl: null,
  newsletterUrl: null,
} as const;

function youtube(rank: number, name: string, handle: string): InfluencerSeedEntry {
  return {
    ...blank,
    rank,
    name,
    youtubeHandle: handle,
    youtubeUrl: `https://www.youtube.com/${encodeURI(handle)}`,
    makesSpecificCalls: "yes",
  };
}

export const ADDED_INFLUENCER_SEEDS: readonly InfluencerSeedEntry[] = [
  {
    ...blank,
    rank: 101,
    name: "PokeInsider (Caleb Nichols)",
    websiteUrl: "https://pokeinsider.com/",
    feedUrl: "https://pokeinsider.com/feed/",
    makesSpecificCalls: "yes",
  },
  youtube(102, "Alpha Investments", "@AlphaInvestments69"),
  youtube(103, "Nostalgia Nomics", "@NostalgiaNomics"),
  youtube(104, "Phillips Collectibles", "@phillips.collectibles"),
  youtube(105, "PikaPikaPaPa", "@PikaPikaPapa"),
  youtube(106, "Poké Pulls TCG", "@PokéPullsCollects"),
  youtube(107, "Poke Moon Investing", "@PokeMoonInvesting"),
  youtube(108, "Poke Profit", "@PokeProfit"),
  youtube(109, "Poke Stocks", "@ThePokeStock"),
  youtube(110, "PokeBeard", "@PokeBeardTCG"),
  youtube(111, "PokeChuck", "@PokeChuck"),
  youtube(112, "PokeJace", "@PokeJace"),
  youtube(113, "PokeOz", "@pokeoz91"),
  youtube(114, "Sam's Shiny Stocks", "@samsshinystocks"),
  youtube(115, "slabhobby", "@slabhobby"),
  youtube(116, "SteelCityStacks", "@SteelCityStacks"),
  youtube(117, "Team Rocket Joey", "@teamrocketjoey"),
  youtube(118, "The Card Science", "@thecardscience"),
  youtube(119, "ThePokePlumber", "@thepokeplumber"),
  youtube(120, "TwicebakedJake", "@TwicebakedJake"),
  youtube(121, "vaporself", "@vaporself"),
  youtube(122, "VegasCardDex", "@VegasCardDex"),
  youtube(123, "YourAsianInvestor", "@YourAsianInvestor"),
];
