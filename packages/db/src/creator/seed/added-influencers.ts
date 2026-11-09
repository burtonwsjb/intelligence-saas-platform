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
 * - 124–134: market channels for the other games TCG Card Central sells,
 *   approved by the owner on 2026-11-09 (One Piece, Yu-Gi-Oh!, Magic,
 *   Lorcana, Dragon Ball Fusion World, Digimon, Flesh and Blood, Star Wars:
 *   Unlimited, Gundam). Channel ids were read from each channel's own
 *   YouTube page. Poke Stocks (Pokemon) is already rank 109.
 *
 * Handles are resolved through the YouTube Data API like every other seed;
 * none is guessed. Being on this list is not authority.
 */
import type { InfluencerSeedEntry } from "../seed.js";

export const ADDED_INFLUENCER_SEED_VERSION = "added_influencers.2026-11-09";

const blank = {
  youtubeChannelId: null,
  youtubeHandle: null,
  youtubeUrl: null,
  websiteUrl: null,
  feedUrl: null,
  newsletterUrl: null,
} as const;

function channel(rank: number, name: string, channelId: string): InfluencerSeedEntry {
  return {
    ...blank,
    rank,
    name,
    youtubeChannelId: channelId,
    youtubeUrl: `https://www.youtube.com/channel/${channelId}`,
    makesSpecificCalls: "yes",
  };
}

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
  channel(124, "One Piece Market", "UC2uF13S5WVwsoi7kcLdRJtQ"),
  channel(125, "House of Champs (Yu-Gi-Oh!)", "UCJitJPaU9ClQ7ivDKEzLNuA"),
  channel(126, "MTG Stocks (Magic)", "UCQYYYpmtaBai1vK7a6ygCVA"),
  channel(127, "The Quest For Lore (Lorcana)", "UCjVbOxo9Mmr7saXhREfkMmw"),
  channel(128, "SaiyanCollectsTCG (Dragon Ball)", "UCTIy-WK3VPqp-uMbf4OvzeA"),
  channel(129, "Mario's Gaming World (Digimon)", "UCe4aEMamMImLDgCtd2Gaz8Q"),
  channel(130, "TCGTed (Flesh and Blood)", "UCOdxqo7yrE5CKVFHKHCnPsA"),
  channel(131, "Unplayable (Star Wars: Unlimited)", "UCaRxbAydIP4P_nNjima5yJA"),
  channel(132, "BoardMatt (Star Wars: Unlimited)", "UCASbMFC84yQRUECyFtSaNXw"),
  channel(133, "TriloG Studio (Gundam)", "UCwzFSiWP-VFblRmEZIpjZgA"),
  channel(134, "Wossy Plays (Gundam)", "UCm5dQhtBpw1S3ajLVPKWs0A"),
];
