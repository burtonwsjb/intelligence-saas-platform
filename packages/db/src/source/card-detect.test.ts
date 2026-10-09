import { describe, expect, it } from "vitest";
import { buildCardNameIndex, collectorNumberAfter, detectCardMentions, detectionKey } from "./card-detect.js";

const index = buildCardNameIndex({
  cards: [
    { name: "Charizard ex", gameKey: "pokemon" },
    { name: "Charizard", gameKey: "pokemon" },
    { name: "Pikachu", gameKey: "pokemon" },
    { name: "Pokémon Center", gameKey: "pokemon" },
    { name: "Energy", gameKey: "pokemon" },
    { name: "Rare Candy", gameKey: "pokemon" },
    { name: "Ultra Ball", gameKey: "pokemon" },
    { name: "Mew", gameKey: "pokemon" },
    { name: "Fire", gameKey: "pokemon" },
    { name: "Monkey D. Luffy", gameKey: "one_piece" },
    { name: "Boss's Orders", gameKey: "pokemon" },
  ],
  sets: [
    { key: "obf", name: "Obsidian Flames", gameKey: "pokemon" },
    { key: "sv1", name: "Scarlet & Violet", gameKey: "pokemon" },
    { key: "op01", name: "Romance Dawn", gameKey: "one_piece" },
  ],
});

describe("detectCardMentions", () => {
  it("finds the longest card name with the collector number and set said next to it", () => {
    const text = "honestly I would buy charizard ex 199 from obsidian flames before it moves";
    const [mention, ...rest] = detectCardMentions(text, index);
    expect(rest).toEqual([]);
    expect(mention).toMatchObject({
      name: "Charizard ex",
      matchedText: "charizard ex",
      gameKey: "pokemon",
      collectorNumber: "199",
      set: { key: "obf", name: "Obsidian Flames", gameKey: "pokemon" },
    });
    expect(text.slice(mention!.start, mention!.end)).toBe("charizard ex");
  });

  it("reads 199/197, '199 out of 197', '#199' and 'number 199'", () => {
    expect(detectCardMentions("Charizard ex 199/197 is insane", index)[0]!.collectorNumber).toBe("199/197");
    expect(detectCardMentions("charizard ex 199 out of 197", index)[0]!.collectorNumber).toBe("199/197");
    expect(detectCardMentions("the Charizard ex #199", index)[0]!.collectorNumber).toBe("199");
    expect(detectCardMentions("charizard ex number 199", index)[0]!.collectorNumber).toBe("199");
  });

  it("does not read prices, counts or years as collector numbers", () => {
    expect(collectorNumberAfter(" 50 dollars right now")).toBeNull();
    expect(collectorNumberAfter(" 3 copies")).toBeNull();
    expect(collectorNumberAfter(" 2023 was crazy")).toBeNull();
    expect(collectorNumberAfter(" $500")).toBeNull();
    expect(collectorNumberAfter(" 4.5 times")).toBeNull();
    expect(detectCardMentions("pikachu 20 percent up", index)[0]!.collectorNumber).toBeNull();
  });

  it("ignores short names, generic words and stoplisted card names", () => {
    const text = "grab an ultra ball, some rare candy, fire energy and go to the pokemon center for mew";
    expect(detectCardMentions(text, index)).toEqual([]);
    expect(detectionKey("Mew")).toBeNull();
    expect(detectionKey("Pokémon Center")).toBeNull();
    expect(detectionKey("123")).toBeNull();
  });

  it("does not treat a set name as a card and matches accents, ampersands and apostrophes", () => {
    const found = detectCardMentions("Boss’s Orders and Pikachu from Scarlet and Violet", index);
    expect(found.map((row) => [row.name, row.set?.key ?? null])).toEqual([
      ["Boss's Orders", "sv1"],
      ["Pikachu", "sv1"],
    ]);
  });

  it("only pairs a card with a set of the same game, and reports a card once per number", () => {
    const found = detectCardMentions(
      "monkey d luffy from obsidian flames, then romance dawn. pikachu pikachu pikachu",
      index,
    );
    expect(found.map((row) => [row.name, row.gameKey, row.set?.key ?? null])).toEqual([
      ["Monkey D. Luffy", "one_piece", "op01"],
      ["Pikachu", "pokemon", "obf"],
    ]);
  });

  it("returns nothing for empty text or an empty catalog", () => {
    expect(detectCardMentions("", index)).toEqual([]);
    expect(detectCardMentions("charizard ex", buildCardNameIndex({ cards: [], sets: [] }))).toEqual([]);
  });
});
