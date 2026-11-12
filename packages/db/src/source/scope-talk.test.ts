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
