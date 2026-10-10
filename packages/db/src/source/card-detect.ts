import { eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { tcgCardConcept, tcgCardNameAlias, tcgSet } from "../schema/tcg.js";

/**
 * Finds catalog card names (and a nearby collector number and set name) in
 * free text such as a transcript window. Longest match over normalized word
 * tokens. Names shorter than four characters and generic words that are also
 * card names are ignored, so ordinary speech does not become a card mention.
 */

/** Generic words and trainer/energy names that are also card names. Normalized token form. */
export const CARD_NAME_STOPLIST = new Set([
  "energy",
  "basic energy",
  "potion",
  "super potion",
  "hyper potion",
  "rare candy",
  "professor",
  "professors research",
  "pokemon center",
  "pokemon centre",
  "pokemon",
  "switch",
  "ultra ball",
  "great ball",
  "poke ball",
  "pokeball",
  "nest ball",
  "quick ball",
  "level ball",
  "master ball",
  "super rod",
  "full heal",
  "boss",
  "trainer",
  "stadium",
  "supporter",
  "item",
  "tool",
  "grass",
  "fire",
  "water",
  "lightning",
  "electric",
  "psychic",
  "fighting",
  "darkness",
  "dark",
  "metal",
  "steel",
  "fairy",
  "dragon",
  "colorless",
  "normal",
  "ghost",
  "poison",
  "ground",
  "rock",
  "flying",
  "bug",
  "ice",
  "promo",
  "promos",
  "booster",
  "booster box",
  "booster pack",
  "elite trainer box",
  "collection",
  "card",
  "cards",
  "pack",
  "packs",
  "market",
  "price",
  "value",
  "rare",
  "holo",
  "gold",
  "silver",
  "black",
  "white",
  "this",
  "that",
  "what",
  "with",
  "your",
  "they",
  "here",
  "there",
  "right",
  "really",
  "going",
  "just",
  "like",
  "think",
  "know",
  "time",
  "today",
  "people",
  "thing",
  "things",
  "good",
  "great",
  "first",
  "last",
  "next",
  "best",
  "chase",
  "hype",
  "crash",
  "sealed",
  "graded",
  "grade",
  "mint",
  "gem mint",
  "base",
]);

export const MIN_CARD_NAME_CHARS = 4;
export const MAX_NAME_TOKENS = 8;

export type CardNameSource = { name: string; gameKey: string };
export type SetNameSource = { key: string; name: string; gameKey: string };

export type CardNameIndex = {
  cards: Map<string, CardNameSource[]>;
  sets: Map<string, SetNameSource[]>;
  maxCardTokens: number;
  maxSetTokens: number;
};

export type DetectedCardMention = {
  /** The catalog name whose tokens matched. */
  name: string;
  /** The text as written in the source. */
  matchedText: string;
  start: number;
  end: number;
  gameKey: string | null;
  collectorNumber: string | null;
  set: SetNameSource | null;
};

type Token = { value: string; start: number; end: number };

const TOKEN = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|&/gu;

function normalizeToken(raw: string): string {
  if (raw === "&") return "and";
  return raw
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en")
    .replace(/['’]/g, "");
}

export function tokenizeForDetection(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const value = normalizeToken(match[0]);
    const start = match.index ?? 0;
    if (value) tokens.push({ value, start, end: start + match[0].length });
  }
  return tokens;
}

/** The normalized lookup key of a name, or null when the name is too short, numeric or generic. */
export function detectionKey(name: string): string | null {
  const tokens = tokenizeForDetection(name).map((token) => token.value);
  if (tokens.length === 0 || tokens.length > MAX_NAME_TOKENS) return null;
  const key = tokens.join(" ");
  if (key.replace(/ /g, "").length < MIN_CARD_NAME_CHARS) return null;
  if (/^[\d ]+$/.test(key)) return null;
  if (CARD_NAME_STOPLIST.has(key)) return null;
  return key;
}

function add<T extends { gameKey: string }>(map: Map<string, T[]>, key: string, value: T, same: (a: T, b: T) => boolean) {
  const list = map.get(key);
  if (!list) map.set(key, [value]);
  else if (!list.some((row) => same(row, value))) list.push(value);
}

export function buildCardNameIndex(input: { cards: CardNameSource[]; sets: SetNameSource[] }): CardNameIndex {
  const index: CardNameIndex = { cards: new Map(), sets: new Map(), maxCardTokens: 0, maxSetTokens: 0 };
  for (const card of input.cards) {
    const key = detectionKey(card.name);
    if (!key) continue;
    add(index.cards, key, card, (a, b) => a.gameKey === b.gameKey);
    index.maxCardTokens = Math.max(index.maxCardTokens, key.split(" ").length);
  }
  for (const set of input.sets) {
    const key = detectionKey(set.name);
    if (!key) continue;
    add(index.sets, key, set, (a, b) => a.gameKey === b.gameKey && a.key === b.key);
    index.maxSetTokens = Math.max(index.maxSetTokens, key.split(" ").length);
  }
  return index;
}

/** Longest spans of `tokens` found in `names`, skipping tokens already used. */
function longestMatches<T>(
  tokens: Token[],
  names: Map<string, T[]>,
  maxTokens: number,
  used: boolean[],
): Array<{ from: number; to: number; key: string; entries: T[] }> {
  const found: Array<{ from: number; to: number; key: string; entries: T[] }> = [];
  let i = 0;
  while (i < tokens.length) {
    let hit: { from: number; to: number; key: string; entries: T[] } | null = null;
    for (let n = Math.min(maxTokens, tokens.length - i); n >= 1 && !hit; n -= 1) {
      let free = true;
      for (let k = i; k < i + n; k += 1) if (used[k]) free = false;
      if (!free) continue;
      const key = tokens
        .slice(i, i + n)
        .map((token) => token.value)
        .join(" ");
      const entries = names.get(key);
      if (entries) hit = { from: i, to: i + n, key, entries };
    }
    if (hit) {
      found.push(hit);
      for (let k = hit.from; k < hit.to; k += 1) used[k] = true;
      i = hit.to;
    } else {
      i += 1;
    }
  }
  return found;
}

const NOT_A_COLLECTOR =
  /^\s*(?:\.\d|,\d|k\b|%|percent|dollars?|bucks|usd|cents?|years?|months?|weeks?|days?|hours?|minutes?|packs?|cards?|copies|boxes|grand|psa|cgc|bgs|times)/i;

/** A collector number written right after a card name: "199/197", "199 of 197", "#199", "number 199", "199". */
export function collectorNumberAfter(text: string): string | null {
  const head = text.slice(0, 48);
  const slash = head.match(
    /^[\s,:(-]*(?:(?:number|num|no\.?|#)\s*)?([a-z]{0,2}\d{1,3})\s*(?:\/|out of|over|of)\s*([a-z]{0,2}\d{1,3})\b/i,
  );
  if (slash) return `${slash[1]}/${slash[2]}`;
  const labelled = head.match(/^[\s,:(-]*(?:number|num|no\.?|#)\s*([a-z]{0,2}\d{1,4})\b/i);
  if (labelled) return labelled[1]!;
  const bare = head.match(/^[\s,:(-]*(\d{1,3})\b/);
  if (bare && !NOT_A_COLLECTOR.test(head.slice(bare.index! + bare[0].length))) return bare[1]!;
  return null;
}

/**
 * Card mentions in `text`. Set names are matched first so a set ("Obsidian
 * Flames") never counts as a card. Each card takes the nearest set name in
 * the same text from the same game, and a collector number written right
 * after it. The same card and number is reported once.
 */
export function detectCardMentions(text: string, index: CardNameIndex): DetectedCardMention[] {
  if (!text || index.cards.size === 0) return [];
  const tokens = tokenizeForDetection(text);
  const used = tokens.map(() => false);
  const sets = longestMatches(tokens, index.sets, index.maxSetTokens, used);
  const cards = longestMatches(tokens, index.cards, index.maxCardTokens, used);
  const seen = new Set<string>();
  const result: DetectedCardMention[] = [];
  for (const card of cards) {
    const start = tokens[card.from]!.start;
    const end = tokens[card.to - 1]!.end;
    const games = new Set(card.entries.map((entry) => entry.gameKey));
    let set: SetNameSource | null = null;
    let distance = Number.POSITIVE_INFINITY;
    for (const candidate of sets) {
      const entry = candidate.entries.find((row) => games.has(row.gameKey));
      if (!entry) continue;
      const gap = candidate.from >= card.to ? candidate.from - card.to : card.from - candidate.to;
      if (gap < distance) {
        distance = gap;
        set = entry;
      }
    }
    const gameKey = set?.gameKey ?? (games.size === 1 ? card.entries[0]!.gameKey : null);
    const entry = card.entries.find((row) => row.gameKey === gameKey) ?? card.entries[0]!;
    const collectorNumber = collectorNumberAfter(text.slice(end));
    const dedupe = `${card.key}|${collectorNumber ?? ""}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    result.push({
      name: entry.name,
      matchedText: text.slice(start, end),
      start,
      end,
      gameKey,
      collectorNumber,
      set,
    });
  }
  return result;
}

/**
 * Loads every catalog card name (canonical names and English aliases) and set
 * name once, for detection over many texts. Bounded by the catalog size.
 */
export async function loadCardNameIndex(db: Database): Promise<CardNameIndex> {
  const concepts = await db
    .select({ name: tcgCardConcept.canonicalName, gameKey: tcgCardConcept.gameKey })
    .from(tcgCardConcept);
  const aliases = await db
    .select({ name: tcgCardNameAlias.name, gameKey: tcgCardConcept.gameKey })
    .from(tcgCardNameAlias)
    .innerJoin(tcgCardConcept, eq(tcgCardConcept.id, tcgCardNameAlias.cardId))
    .where(eq(tcgCardNameAlias.languageCode, "en"));
  const sets = await db
    .select({ key: tcgSet.canonicalSetKey, name: tcgSet.name, gameKey: tcgSet.gameKey })
    .from(tcgSet);
  return buildCardNameIndex({ cards: [...concepts, ...aliases], sets });
}
