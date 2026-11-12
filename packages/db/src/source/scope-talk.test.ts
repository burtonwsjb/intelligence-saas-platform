import { describe, expect, it } from "vitest";
import { buildCardNameIndex } from "./card-detect.js";
import {
  buildScopeSetIndex,
  clauseDirection,
  extractScopeTalk,
  parseTalkHorizon,
  talkAgeFactor,
  type ScopeTalkStatement,
} from "./scope-talk.js";

const sets = buildScopeSetIndex([
  { setId: "pre", gameKey: "pokemon", name: "SV: Prismatic Evolutions" },
  { setId: "pfl", gameKey: "pokemon", name: "ME02: Phantasmal Flames" },
  { setId: "ssp", gameKey: "pokemon", name: "SV08: Surging Sparks" },
  { setId: "obf", gameKey: "pokemon", name: "SV03: Obsidian Flames" },
  { setId: "op01", gameKey: "one_piece", name: "Romance Dawn" },
]);
const cards = buildCardNameIndex({
  cards: [
    { name: "Charizard", gameKey: "pokemon" },
    { name: "Pikachu ex", gameKey: "pokemon" },
    { name: "Umbreon ex", gameKey: "pokemon" },
  ],
  sets: [],
});
const posted = new Date("2026-11-12T00:00:00Z");

function brief(rows: ScopeTalkStatement[]) {
  return rows.map((row) =>
    [row.setId, row.scope, row.productType ?? row.grade ?? row.rarity ?? row.cardName ?? "", row.sentiment].join(":"),
  );
}

describe("clauseDirection", () => {
  it("reads negated buys and plain up/down", () => {
    expect(clauseDirection("hold off on buying them until the end of the year")).toBe("negative");
    expect(clauseDirection("don't buy these yet")).toBe("negative");
    expect(clauseDirection("singles are going up")).toBe("positive");
    expect(clauseDirection("sealed is probably gonna be going down")).toBe("negative");
    expect(clauseDirection("it's not going down anytime soon")).toBe("positive");
    expect(clauseDirection("ETBs down")).toBe("negative");
    expect(clauseDirection("I pulled this yesterday")).toBeNull();
  });
});

describe("extractScopeTalk", () => {
  it("reads a whole set of singles from a nickname next to a scope word", () => {
    const rows = extractScopeTalk(
      "The Prismatic set of single cards are probably gonna be going down, so hold off on buying them until end of the year.",
      sets,
      cards,
      posted,
    );
    expect(brief(rows)).toEqual(["pre:singles::negative"]);
    expect(rows[0]!.horizonDays).toBe(49);
  });

  it("splits sealed and singles and keeps the named card at card level", () => {
    const rows = extractScopeTalk(
      "The sealed of Phantasmal Flames is going down, but the singles are going up, especially the Charizard.",
      sets,
      cards,
    );
    expect(brief(rows)).toEqual(["pfl:sealed::negative", "pfl:singles::positive", "pfl:card:charizard:positive"]);
  });

  it("separates grades", () => {
    const rows = extractScopeTalk("Surging Sparks graded PSA 10 cards are going up but PSA nine cards are going down.", sets, cards);
    expect(brief(rows)).toEqual(["ssp:graded:PSA 10:positive", "ssp:graded:PSA 9:negative"]);
  });

  it("takes an exception out of a set-wide call", () => {
    const rows = extractScopeTalk("All of Surging Sparks is going down except this Pikachu ex.", sets, cards);
    expect(brief(rows)).toEqual(["ssp:set::negative", "ssp:card:pikachu ex:excluded"]);
  });

  it("separates sealed products", () => {
    const rows = extractScopeTalk("Prismatic Evolutions booster boxes are going up but ETBs are dropping.", sets, cards);
    expect(brief(rows)).toEqual(["pre:sealed:booster_box:positive", "pre:sealed:elite_trainer_box:negative"]);
  });

  it("carries the set into the next sentence and reads rarity groups", () => {
    const rows = extractScopeTalk("Let's talk Obsidian Flames. The SIRs are climbing fast.", sets, cards);
    expect(brief(rows)).toEqual(["obf:rarity:Special Illustration Rare:positive"]);
  });

  it("ignores nicknames without a scope word and texts with no direction", () => {
    expect(extractScopeTalk("That was a prismatic moment, going up!", sets, cards)).toEqual([]);
    expect(extractScopeTalk("Opening Surging Sparks booster boxes today.", sets, cards)).toEqual([]);
  });

  it("applies a direction given after a list of products", () => {
    const rows = extractScopeTalk("Surging Sparks booster boxes, ETBs, those are all going down.", sets, cards);
    expect(brief(rows)).toEqual(["ssp:sealed:booster_box:negative", "ssp:sealed:elite_trainer_box:negative"]);
  });
});

describe("time frames", () => {
  it("reads spans, months and the end of the year", () => {
    expect(parseTalkHorizon("over the next couple months", posted)?.days).toBe(60);
    expect(parseTalkHorizon("wait until January to buy", posted)?.days).toBe(50);
    expect(parseTalkHorizon("by the end of the year", posted)?.days).toBe(49);
    expect(parseTalkHorizon("in 3 weeks", posted)?.days).toBe(21);
    expect(parseTalkHorizon("it's going down", posted)).toBeNull();
  });

  it("fades calls without a time frame and stops calls whose frame ended", () => {
    expect(talkAgeFactor(10, null)).toBe(1);
    expect(talkAgeFactor(60, null)).toBeCloseTo(0.5);
    expect(talkAgeFactor(95, null)).toBe(0);
    expect(talkAgeFactor(45, 50)).toBe(1);
    expect(talkAgeFactor(51, 50)).toBe(0);
  });
});

describe("creator call time frames", () => {
  it("reads a spoken time frame into the call so it is judged then", async () => {
    const { extractCallDeterministic } = await import("../creator/extract.js");
    const call = extractCallDeterministic({ text: "This set is going down, wait until January to buy", publishedAt: posted });
    expect(call?.horizon_code).toBe("custom");
    expect(call?.horizon_custom_days).toBe(50);
    const plain = extractCallDeterministic({ text: "This set is going down" , publishedAt: posted });
    expect(plain?.horizon_code).toBe("unspecified");
    const months = extractCallDeterministic({ text: "sell now, it drops over the next 3 months", publishedAt: posted });
    expect(months?.horizon_code).toBe("90d");
  });
});

describe("graders across sentences", () => {
  it("carries a grader to a bare grade in the next sentence only", () => {
    const rows = extractScopeTalk("Surging Sparks PSA 10s are going up. The 9s are going down.", sets, cards);
    expect(rows.map((row) => `${row.grade}:${row.sentiment}`)).toEqual(["PSA 10:positive", "PSA 9:negative"]);
  });
});

describe("real post wording seen on staging (2026-11-12)", () => {
  const live = buildScopeSetIndex([
    { setId: "jtg", gameKey: "pokemon", name: "SV09: Journey Together" },
    { setId: "sit", gameKey: "pokemon", name: "SWSH12: Silver Tempest" },
    { setId: "evs", gameKey: "pokemon", name: "SWSH07: Evolving Skies" },
    { setId: "meg", gameKey: "pokemon", name: "ME01: Mega Evolution" },
    { setId: "n1", gameKey: "pokemon", name: "Neo Genesis" },
    { setId: "pfl", gameKey: "pokemon", name: "ME02: Phantasmal Flames" },
    { setId: "pre", gameKey: "pokemon", name: "SV: Prismatic Evolutions" },
  ]);
  const read = (text: string) => brief(extractScopeTalk(text, live, cards, posted));

  it("ignores opening product, shop links and price quotes", () => {
    expect(read("Ripping packs of Phantasmal Flames until we get a hit")).toEqual([]);
    expect(read("► Buy Mega Evolution Booster Box from Buyee")).toEqual([]);
    expect(read("A 1st Edition Neo Genesis booster box will run you around $12")).toEqual([]);
    expect(read("An Alternate Art Rayquaza from Evolving Skies might sell raw for $130")).toEqual([]);
  });

  it("reads one card with a rarity as that card, not its whole rarity group", () => {
    expect(read("Silver Tempest Lugia V Alt Art dropped 12% to around $360")).not.toContain("sit:rarity:Alternate Art:negative");
    expect(read("Silver Tempest alt arts dropped 12% this month")).toEqual(["sit:rarity:Alternate Art:negative"]);
  });

  it("keeps real calls", () => {
    expect(read("Journey Together represents the clearest sell signal in the current market")).toEqual(["jtg:set::negative"]);
    expect(read("Prismatic Evolutions is Extremely Undervalued")).toEqual(["pre:set::positive"]);
    expect(read("Phantasmal Flames Prices Are Already Crashing A Week After Release")).toEqual(["pfl:set::negative"]);
  });

  it("skips questions but not orders", () => {
    expect(read("Will Prismatic Evolutions keep appreciating at this pace?")).toEqual([]);
    expect(read("Do not buy Prismatic Evolutions booster boxes yet")).toEqual(["pre:sealed:booster_box:negative"]);
  });

  it("does not read a past month as a time frame", () => {
    const rows = extractScopeTalk("Journey Together is a sell, all top cards lost value in November", live, cards, posted);
    expect(rows[0]?.horizonDays).toBeNull();
  });

  it("does not carry a later direction back to a product only mentioned", () => {
    expect(read("Ascended Heroes will be a Special Set without booster boxes, but the Mega Evolution packs are going up")).toEqual([
      "meg:sealed:booster_pack:positive",
    ]);
  });

  it("does not read releases, retail, hunting or doubts as price calls (2026-11-12 v2 sample)", () => {
    expect(read("Pokémon Ascended Heroes Pre-Orders About to Drop")).toEqual([]);
    expect(read("Costco is dropping TWO massive Pokémon premium boxes soon")).toEqual([]);
    expect(read("The Prismatic Evolutions Premium Figure Collection Should Have Dropped in September")).toEqual([]);
    expect(read("New Store Selling CHEAP Pokemon TCG Products Announced")).toEqual([]);
    expect(read("We're down to the last 5 major cards needed to finish our Mega Evolution master set")).toEqual([]);
    expect(read("Mega Evolution chase cards and we're still hunting it down")).toEqual([]);
    expect(read("buzz that another set called Phantasmal Flames might steal some thunder at launch")).toEqual([]);
    expect(read("Evolving Skies Alternate Art Buying Guide")).toEqual([]);
    expect(read("I doubt Ascended Heroes will trigger the same buying frenzy Prismatic Evolutions achieved")).toEqual([]);
  });

  it("reads prices that held as neutral and keeps real buy calls and price moves", () => {
    expect(read("Phantasmal Flames Prices Haven't Dropped")).toEqual(["pfl:set::neutral"]);
    expect(read("The SHOCKING Truth About Phantasmal Flames… + What I'm Loading Up On")).toEqual(["pfl:set::positive"]);
    expect(read("Time to buy Prismatic Evolutions booster boxes")).toEqual(["pre:sealed:booster_box:positive"]);
    expect(read("Prices across the board have dropped by Phantasmal Flames")).toEqual(["pfl:set::negative"]);
  });

  it("does not read TAG TEAM or ACE SPEC cards as graded", () => {
    const rows = extractScopeTalk("TAG TEAM GX cards from Silver Tempest continue climbing", live, cards, posted);
    expect(rows.some((row) => row.scope === "graded")).toBe(false);
  });
});
