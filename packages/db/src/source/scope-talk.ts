/**
 * Market talk about more than one card: a whole set ("Prismatic is going
 * down"), the set's singles, its graded cards ("PSA 10s up, PSA 9s down"), a
 * group of its cards ("the SIRs"), its sealed products ("booster boxes up but
 * ETBs down") and the cards a speaker singles out ("especially the
 * Charizard", "except this Pikachu").
 *
 * The text is split into sentences and clauses ("but", "while", commas,
 * "except"), and each clause becomes one or more scoped statements with the
 * direction written in that clause. A clause that names no set uses the set
 * named just before it in the same text. Pure; storage is in
 * scope-talk-store.ts.
 */
import { detectCardMentions, detectionKey, tokenizeForDetection, type CardNameIndex } from "./card-detect.js";

export const SCOPE_TALK_VERSION = "scope_talk.v1";
/** Longest stored clause. Retention: a bounded quote, never the full text. */
export const SCOPE_TALK_CLAUSE_MAX_CHARS = 280;
/** At most this many statements are read out of one text. */
export const SCOPE_TALK_MAX_PER_TEXT = 40;
/** A set named in one sentence still applies to this many following sentences that name none. */
const SET_CARRY_SENTENCES = 2;

export type ScopeKind = "set" | "singles" | "graded" | "rarity" | "sealed" | "card";
/** "excluded": the speaker took this target out of a wider call ("except this Pikachu") without saying which way it goes. */
export type ScopeSentiment = "positive" | "negative" | "neutral" | "excluded";

export type ScopeSet = {
  setId: string;
  gameKey: string;
  /** Names that count on their own (catalog name, name without a code prefix). */
  names: string[];
  /** Short names ("Prismatic") that count only next to a scope word ("the Prismatic set", "Prismatic sealed"). */
  nicknames: string[];
};

export type ScopeTalkStatement = {
  setId: string;
  scope: ScopeKind;
  /** Sealed only: booster_box, elite_trainer_box, booster_bundle, booster_pack, tin, collection; null for sealed in general. */
  productType: string | null;
  /** Graded only: "PSA 10", "BGS 9.5", "CGC"; null for graded cards in general. */
  grade: string | null;
  /** Rarity groups: the catalog rarity ("Special Illustration Rare"). */
  rarity: string | null;
  /** Card statements: the card name as the catalog spells it, normalized. */
  cardName: string | null;
  sentiment: ScopeSentiment;
  /** The clause the statement was read from, bounded. */
  clause: string;
  /** Character offset of the clause in the text. */
  start: number;
  /** Days the speaker gave the call ("until January"), null when none. */
  horizonDays: number | null;
  horizonPhrase: string | null;
};

export type ScopeSetIndex = {
  /** detection key -> sets with that name */
  names: Map<string, ScopeSet[]>;
  nicknames: Map<string, ScopeSet[]>;
  maxTokens: number;
};

/** Generic first words that never stand for a set on their own. */
const NICKNAME_STOPLIST = new Set([
  "black", "white", "great", "battle", "super", "ultra", "hidden", "lost", "silver", "dark", "shining", "crown",
  "legend", "legends", "power", "star", "stars", "team", "rising", "champion", "champions", "evolving", "evolutions",
  "chilling", "fusion", "brilliant", "vivid", "darkness", "astral", "temporal", "paradox", "first", "base", "promo",
  "promos", "trainer", "mega", "core", "starter", "deck", "booster", "collection", "special", "edition", "classic",
  "the", "magic", "pokemon", "digimon", "gundam", "lorcana", "one", "piece", "dragon", "ball", "scarlet", "violet",
  "sword", "shield", "sun", "moon", "world", "worlds", "new", "into", "rise", "return", "shadow", "shadows", "royal",
  "heroes", "journey", "together", "destined", "rivals", "surging", "stellar", "twilight", "shrouded", "fable",
]);

/** "SV: Prismatic Evolutions" -> "Prismatic Evolutions". */
function withoutCodePrefix(name: string): string {
  return name.trim().match(/^[A-Za-z0-9.]{1,8}:\s+(.+)$/)?.[1]?.trim() ?? name.trim();
}

/**
 * Builds the set lookup. A name or nickname that more than one set of the
 * same game shares is nobody's: such a post cannot say which set it means.
 * Sets of different games may share a name; the clause keeps all of them only
 * when it names the game, else it is skipped.
 */
export function buildScopeSetIndex(
  sets: Array<{ setId: string; gameKey: string; name: string }>,
): ScopeSetIndex {
  const names = new Map<string, ScopeSet[]>();
  const nicknames = new Map<string, ScopeSet[]>();
  const nickCount = new Map<string, number>();
  const byId = new Map<string, ScopeSet>();
  for (const set of sets) {
    if (/promo/i.test(set.name)) continue;
    const full = detectionKey(set.name);
    const stripped = detectionKey(withoutCodePrefix(set.name));
    const entry: ScopeSet = { setId: set.setId, gameKey: set.gameKey, names: [], nicknames: [] };
    for (const key of new Set([full, stripped].filter((k): k is string => !!k))) entry.names.push(key);
    const first = stripped?.split(" ")[0];
    if (stripped && first && stripped.includes(" ") && first.length >= 5 && !NICKNAME_STOPLIST.has(first) && !/^\d+$/.test(first)) {
      entry.nicknames.push(first);
      nickCount.set(`${set.gameKey}|${first}`, (nickCount.get(`${set.gameKey}|${first}`) ?? 0) + 1);
    }
    byId.set(set.setId, entry);
  }
  const nameCount = new Map<string, number>();
  for (const entry of byId.values()) for (const key of entry.names) nameCount.set(`${entry.gameKey}|${key}`, (nameCount.get(`${entry.gameKey}|${key}`) ?? 0) + 1);
  let maxTokens = 1;
  for (const entry of byId.values()) {
    entry.names = entry.names.filter((key) => nameCount.get(`${entry.gameKey}|${key}`) === 1);
    entry.nicknames = entry.nicknames.filter((key) => nickCount.get(`${entry.gameKey}|${key}`) === 1);
    for (const key of entry.names) {
      names.set(key, [...(names.get(key) ?? []), entry]);
      maxTokens = Math.max(maxTokens, key.split(" ").length);
    }
    for (const key of entry.nicknames) nicknames.set(key, [...(nicknames.get(key) ?? []), entry]);
  }
  // A nickname that is also a full set name of another set is ambiguous.
  for (const key of nicknames.keys()) if (names.has(key)) nicknames.delete(key);
  return { names, nicknames, maxTokens };
}

/**
 * A card name as stored on a statement and compared in SQL: lower case,
 * accents dropped, every run of other characters one space. Postgres applies
 * the same rule to catalog names (see scopeTalkEvidenceSql).
 */
export function cardNameKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Scope words

const PRODUCT_WORDS: Array<{ re: RegExp; type: string | null }> = [
  { re: /\bbooster\s+box(?:es)?\b|\bbooster\s+displays?\b|\bdisplays?\b|\bbbs?\b|\bboxes\b/i, type: "booster_box" },
  { re: /\belite\s+trainer\s+box(?:es)?\b|\betbs?\b/i, type: "elite_trainer_box" },
  { re: /\bbooster\s+bundles?\b|\bbundles?\b/i, type: "booster_bundle" },
  { re: /\bbooster\s+packs?\b|\bpacks?\b|\bblisters?\b/i, type: "booster_pack" },
  { re: /\btins?\b/i, type: "tin" },
  { re: /\bcollection\s+box(?:es)?\b|\bupcs?\b|\bultra\s+premium\s+collections?\b|\bpremium\s+collections?\b|\bspcs?\b/i, type: "collection" },
  { re: /\bsealed\b|\bsealed\s+products?\b|\bproducts?\b|\bcases?\b/i, type: null },
];

const GRADERS = "psa|bgs|beckett|cgc|sgc|tag|ace";
const GRADE_NUMBER_WORDS: Record<string, string> = {
  ten: "10", nine: "9", eight: "8", seven: "7", six: "6", five: "5",
};
const GRADED_GENERIC = /\bgraded\b|\bslabs?\b|\bslabbed\b|\bgem\s+mints?\b|\bgems\b/i;
const SINGLES = /\bsingles?\b|\bsingle\s+cards?\b|\braw\s+cards?\b|\braw\b|\bchase\s+cards?\b|\bchases\b|\bhits\b|\bthe\s+cards\b|\bcards\s+from\b/i;

/** Rarity groups people talk about, mapped to the catalog spelling. */
const RARITY_GROUPS: Array<{ re: RegExp; rarity: string }> = [
  { re: /\bspecial\s+illustration\s+rares?\b|\bSIRs?\b|\bSARs?\b|\bspecial\s+art\s+rares?\b/, rarity: "Special Illustration Rare" },
  { re: /\bhyper\s+rares?\b|\bgold\s+cards\b|\bgolds\b/i, rarity: "Hyper Rare" },
  { re: /\bmega\s+hyper\s+rares?\b/i, rarity: "Mega Hyper Rare" },
  { re: /\billustration\s+rares?\b|\bIRs\b|\bARs\b|\bart\s+rares?\b/, rarity: "Illustration Rare" },
  { re: /\bultra\s+rares?\b|\bfull\s+arts?\b/i, rarity: "Ultra Rare" },
  { re: /\bdouble\s+rares?\b/i, rarity: "Double Rare" },
  { re: /\bsecret\s+rares?\b|\bsecrets\b/i, rarity: "Secret Rare" },
  { re: /\balt(?:ernate)?\s+arts?\b|\balt\s+art\s+cards\b/i, rarity: "Alternate Art" },
  // Manga rares are not told apart from other special finishes in the catalog, so they are not read as a group.
  { re: /\bparallels?\b|\bparallel\s+arts?\b/i, rarity: "Parallel" },
  { re: /\benchanted\b/i, rarity: "Enchanted" },
];

// ---------------------------------------------------------------------------
// Direction

const NEG_BUY = /\b(?:hold\s+off(?:\s+on)?|wait(?:\s+(?:to|on|for|until|till))?|don'?t|do\s+not|never|stop|not|no\s+need\s+to|avoid)\s+(?:\w+\s+){0,2}?(?:buy(?:ing)?|pick(?:ing)?\s+up|chas(?:e|ing)|invest(?:ing)?)\b/i;
const NEG_UP = /\b(?:not|never|isn'?t|aren'?t|won'?t|don'?t\s+(?:see|think))\s+(?:\w+\s+){0,2}?(?:going\s+up|go(?:ing)?\s+up|rise|rising|climb(?:ing)?|moon(?:ing)?)\b/i;
const NEG_DOWN = /\b(?:not|never|isn'?t|aren'?t|won'?t|don'?t\s+(?:see|think))\s+(?:\w+\s+){0,2}?(?:going\s+down|go(?:ing)?\s+down|drop(?:ping)?|fall(?:ing)?|crash(?:ing)?|dip(?:ping)?)\b/i;
const NEGATIVE = [
  /\bgo(?:ing|nna|es)?\s+(?:to\s+)?(?:be\s+)?(?:going\s+)?down\b/i,
  /\b(?:is|are|'s|'re|been|be|keeps?|kept|went|trending|heading|headed|way|coming)\s+(?:\w+\s+)?down\b/i,
  /\bdown\s+(?:bad|hard|big|a\s+lot|\d+\s*%)/i,
  /\b(?:will|gonna|going\s+to|about\s+to|could|might|should)\s+(?:\w+\s+)?(?:drop|fall|crash|tank|dip|decline|plummet|collapse|correct)\b/i,
  /\b(?:dropping|falling|crashing|tanking|dipping|declining|plummeting|collapsing|sinking|bleeding|cooling\s+off|softening|correcting)\b/i,
  /\b(?:dropped|fell|crashed|tanked|dipped|declined|plummeted|collapsed)\b/i,
  /\b(?:sell|selling|sell\s+off|dump(?:ing)?|offload(?:ing)?|get\s+out|cash\s+out|take\s+profits?)\b/i,
  /\b(?:overpriced|overvalued|over\s*hyped|bubble|peaked|saturated|oversupplied|flooded|flooding|reprints?|reprinted|bearish)\b/i,
  /\b(?:stay\s+away|avoid)\b/i,
  /\blose\s+value\b|\blosing\s+value\b/i,
];
const POSITIVE = [
  /\bgo(?:ing|nna|es)?\s+(?:to\s+)?(?:be\s+)?(?:going\s+)?up\b/i,
  /\b(?:is|are|'s|'re|been|be|keeps?|kept|went|trending|heading|headed|way|shooting|creeping|climbing)\s+(?:\w+\s+)?up\b/i,
  /\bup\s+(?:big|a\s+lot|\d+\s*%)/i,
  /\b(?:will|gonna|going\s+to|about\s+to|could|might|should)\s+(?:\w+\s+)?(?:rise|climb|pump|moon|spike|explode|skyrocket|increase|appreciate|double|take\s+off)\b/i,
  /\b(?:rising|climbing|pumping|mooning|spiking|exploding|skyrocketing|increasing|appreciating|gaining|ripping|heating\s+up|taking\s+off)\b/i,
  /\b(?:buy|buying|pick\s+up|picking\s+up|scoop(?:ing)?|load\s+up|loading\s+up|grab(?:bing)?|stack(?:ing)?|accumulat(?:e|ing))\b/i,
  /\b(?:undervalued|underpriced|bullish|sleeper|steal|great\s+investment|good\s+investment|long\s+term\s+hold)\b/i,
];
const NEUTRAL = [/\b(?:hold|holding|flat|stable|steady|sideways|stagnant|leveled\s+off|levelled\s+off)\b/i];

/** Bare "up"/"down" right after a scope word: "sealed down, singles up", "PSA 10s up". */
const BARE_UP = /\b(?:sealed|singles|boxes|etbs?|bundles|packs|slabs|graded|10s|9s|cards|set|it|they|them|products?)\s+(?:\w+\s+)?up\b/i;
const BARE_DOWN = /\b(?:sealed|singles|boxes|etbs?|bundles|packs|slabs|graded|10s|9s|cards|set|it|they|them|products?)\s+(?:\w+\s+)?down\b/i;

/** The direction a clause states, or null when it states none. Negated phrases are read first. */
export function clauseDirection(clause: string): "positive" | "negative" | "neutral" | null {
  const text = clause.replace(/[’]/g, "'");
  if (NEG_BUY.test(text)) return "negative";
  if (NEG_UP.test(text)) return "negative";
  if (NEG_DOWN.test(text)) return "positive";
  const neg = NEGATIVE.some((re) => re.test(text)) || BARE_DOWN.test(text);
  const pos = POSITIVE.some((re) => re.test(text)) || BARE_UP.test(text);
  if (neg && !pos) return "negative";
  if (pos && !neg) return "positive";
  if (pos && neg) {
    // "buy the dip", "sell high" read both ways; the price direction words decide.
    const down = /\bdown\b|\bdrop|\bfall|\bcrash|\btank|\bdip\b/i.test(text);
    const up = /\bup\b|\brise|\bclimb|\bpump|\bmoon|\bspike/i.test(text);
    if (down && !up) return "negative";
    if (up && !down) return "positive";
    return null;
  }
  if (NEUTRAL.some((re) => re.test(text))) return "neutral";
  return null;
}

// ---------------------------------------------------------------------------
// Splitting

type Clause = { text: string; start: number; sentence: number; sentenceText: string; exception: boolean; emphasis: boolean };

const CLAUSE_BREAK = /\s*(?:,|;|:|\s-\s|\s–\s|\bbut\b|\bwhile\b|\bwhereas\b|\bhowever\b|\balthough\b|\bthough\b|\byet\b|\bmeanwhile\b|\bon\s+the\s+other\s+hand\b)\s*/gi;
const EXCEPTION_START = /^(?:except(?:\s+for)?|other\s+than|apart\s+from|aside\s+from|besides|excluding|minus|not\s+including|outside\s+of)\b\s*/i;
const EXCEPTION_INSIDE = /\s+(?=(?:except(?:\s+for)?|other\s+than|apart\s+from|aside\s+from|excluding|not\s+including|outside\s+of)\b)/i;
const EMPHASIS_START = /^(?:especially|particularly|mainly|mostly|specifically|in\s+particular|like|such\s+as|including|namely)\b\s*/i;
const EMPHASIS_INSIDE = /\s+(?=(?:especially|particularly|specifically|in\s+particular|such\s+as|including|namely)\b)/i;

function splitClauses(text: string): Clause[] {
  const clauses: Clause[] = [];
  const sentenceRe = /[^.!?\n]+[.!?]*/g;
  let sentence = 0;
  for (const match of text.matchAll(sentenceRe)) {
    const sentenceText = match[0];
    const base = match.index ?? 0;
    let cursor = 0;
    const parts: Array<{ text: string; start: number }> = [];
    for (const brk of sentenceText.matchAll(CLAUSE_BREAK)) {
      const at = brk.index ?? 0;
      parts.push({ text: sentenceText.slice(cursor, at), start: base + cursor });
      cursor = at + brk[0].length;
    }
    parts.push({ text: sentenceText.slice(cursor), start: base + cursor });
    for (const part of parts) {
      // "... down except this Pikachu" / "... up especially the Charizard": split before the marker.
      const pieces: Array<{ text: string; start: number }> = [];
      let rest = part;
      for (;;) {
        const inside = rest.text.match(EXCEPTION_INSIDE) ?? rest.text.match(EMPHASIS_INSIDE);
        if (!inside || inside.index == null || inside.index === 0) break;
        const cut = inside.index + inside[0].length;
        pieces.push({ text: rest.text.slice(0, inside.index), start: rest.start });
        rest = { text: rest.text.slice(cut), start: rest.start + cut };
      }
      pieces.push(rest);
      for (const piece of pieces) {
        const trimmed = piece.text.trim().replace(/[.!?]+$/, "");
        if (!trimmed) continue;
        const lead = piece.text.length - piece.text.trimStart().length;
        const exception = EXCEPTION_START.test(trimmed);
        const emphasis = !exception && EMPHASIS_START.test(trimmed);
        clauses.push({ text: trimmed, start: piece.start + lead, sentence, sentenceText, exception, emphasis });
      }
    }
    sentence += 1;
  }
  return clauses;
}

// ---------------------------------------------------------------------------
// Reading one clause

type Found = { sets: ScopeSet[]; gameNamed: Set<string> };

const GAME_WORDS: Record<string, RegExp> = {
  pokemon: /\bpok[eé]mon\b/i,
  magic: /\bmagic\b|\bmtg\b/i,
  yugioh: /\byu-?gi-?oh\b/i,
  one_piece: /\bone\s+piece\b/i,
  lorcana: /\blorcana\b/i,
};

const SCOPE_WORD = new RegExp(
  `\\bset\\b|${SINGLES.source}|${GRADED_GENERIC.source}|\\b(?:${GRADERS})\\b|${PRODUCT_WORDS.map((p) => p.re.source).join("|")}`,
  "i",
);

function findSets(clause: string, index: ScopeSetIndex): Found {
  const tokens = tokenizeForDetection(clause).map((token) => token.value);
  const sets = new Map<string, ScopeSet>();
  const gameNamed = new Set<string>();
  for (const [game, re] of Object.entries(GAME_WORDS)) if (re.test(clause)) gameNamed.add(game);
  for (let i = 0; i < tokens.length; i += 1) {
    for (let n = Math.min(index.maxTokens, tokens.length - i); n >= 1; n -= 1) {
      const key = tokens.slice(i, i + n).join(" ");
      const hits = index.names.get(key);
      if (hits) {
        for (const hit of hits) sets.set(hit.setId, hit);
        i += n - 1;
        break;
      }
      if (n === 1) {
        const nick = index.nicknames.get(key);
        if (nick && SCOPE_WORD.test(clause)) for (const hit of nick) sets.set(hit.setId, hit);
      }
    }
  }
  let list = [...sets.values()];
  const games = new Set(list.map((set) => set.gameKey));
  if (games.size > 1) {
    // The same name in two games: only the game the clause names, else nothing.
    list = gameNamed.size ? list.filter((set) => gameNamed.has(set.gameKey)) : [];
  }
  return { sets: list, gameNamed };
}

function gradesIn(clause: string, carriedGrader: string | null): { grades: string[]; generic: boolean; grader: string | null } {
  const text = clause.replace(/\b(ten|nine|eight|seven|six|five)s?\b/gi, (word) => GRADE_NUMBER_WORDS[word.toLowerCase().replace(/s$/, "")] ?? word);
  const grades: string[] = [];
  let grader = carriedGrader;
  const re = new RegExp(`\\b(${GRADERS})\\s*(10|9\\.5|9|8\\.5|8|7|6|5)?(?:s\\b|\\b)`, "gi");
  for (const match of text.matchAll(re)) {
    const company = match[1]!.toUpperCase() === "BECKETT" ? "BGS" : match[1]!.toUpperCase();
    grader = company;
    grades.push(match[2] ? `${company} ${match[2]}` : company);
  }
  if (grades.length === 0 && grader) {
    // "PSA 10s are up, 9s are down": a bare grade after a grader named earlier.
    for (const match of text.matchAll(/\b(10|9\.5|9|8)(?:s\b|\s+(?:cards|copies|slabs)\b)/gi)) grades.push(`${grader} ${match[1]}`);
  }
  return { grades: [...new Set(grades)], generic: GRADED_GENERIC.test(clause), grader };
}

function productTypesIn(clause: string): Array<string | null> {
  let text = clause;
  const types: Array<string | null> = [];
  for (const entry of PRODUCT_WORDS) {
    if (entry.re.test(text)) {
      types.push(entry.type);
      // "booster box" must not also read as "box"/"packs" further down the list.
      text = text.replace(new RegExp(entry.re.source, "gi"), " ");
    }
  }
  // "sealed booster boxes": the specific product is enough.
  return types.some((type) => type != null) ? types.filter((type) => type != null) : types;
}

function raritiesIn(clause: string): string[] {
  let text = clause;
  const out: string[] = [];
  for (const group of [...RARITY_GROUPS].sort((a, b) => b.re.source.length - a.re.source.length)) {
    if (group.re.test(text)) {
      out.push(group.rarity);
      text = text.replace(new RegExp(group.re.source, group.re.flags.includes("g") ? group.re.flags : `${group.re.flags}g`), " ");
    }
  }
  return [...new Set(out)];
}

function bound(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= SCOPE_TALK_CLAUSE_MAX_CHARS ? clean : `${clean.slice(0, SCOPE_TALK_CLAUSE_MAX_CHARS - 1).trimEnd()}…`;
}

type Scopes = {
  products: Array<string | null>;
  grades: string[];
  gradedGeneric: boolean;
  singles: boolean;
  rarities: string[];
  cards: string[];
};

function scopesOf(clause: string, cardIndex: CardNameIndex | null, grader: string | null, setNames: ScopeSet[]) {
  const products = productTypesIn(clause);
  const graded = gradesIn(clause, grader);
  const rarities = raritiesIn(clause);
  const cards = cardIndex
    ? [
        ...new Set(
          detectCardMentions(clause, cardIndex)
            .filter((card) => !card.gameKey || setNames.length === 0 || setNames.some((set) => set.gameKey === card.gameKey))
            .map((card) => cardNameKey(card.name)),
        ),
      ]
    : [];
  const scopes: Scopes = {
    products,
    grades: graded.grades,
    gradedGeneric: graded.generic && graded.grades.length === 0,
    singles: SINGLES.test(clause),
    rarities,
    cards,
  };
  return { scopes, grader: graded.grader };
}

function hasScope(scopes: Scopes) {
  return (
    scopes.products.length > 0 ||
    scopes.grades.length > 0 ||
    scopes.gradedGeneric ||
    scopes.singles ||
    scopes.rarities.length > 0 ||
    scopes.cards.length > 0
  );
}

function statementsFor(
  set: ScopeSet,
  scopes: Scopes,
  sentiment: ScopeSentiment,
  clause: Clause,
  wholeSetWhenBare: boolean,
  publishedAt: Date | null,
  fullText: string,
): ScopeTalkStatement[] {
  // The time frame of the clause, else its sentence, else the text around it
  // ("All of Surging Sparks is going down. Wait until January to buy.").
  const horizon = publishedAt
    ? (parseTalkHorizon(clause.text, publishedAt) ??
      parseTalkHorizon(clause.sentenceText, publishedAt) ??
      parseTalkHorizon(fullText, publishedAt))
    : null;
  const base = {
    setId: set.setId,
    sentiment,
    clause: bound(clause.text),
    start: clause.start,
    horizonDays: horizon?.days ?? null,
    horizonPhrase: horizon?.phrase ?? null,
  };
  const out: ScopeTalkStatement[] = [];
  const blank = { productType: null, grade: null, rarity: null, cardName: null };
  for (const card of scopes.cards) out.push({ ...base, ...blank, scope: "card", cardName: card });
  for (const rarity of scopes.rarities) out.push({ ...base, ...blank, scope: "rarity", rarity });
  for (const grade of scopes.grades) out.push({ ...base, ...blank, scope: "graded", grade });
  if (scopes.gradedGeneric) out.push({ ...base, ...blank, scope: "graded" });
  for (const productType of scopes.products) out.push({ ...base, ...blank, scope: "sealed", productType });
  if (scopes.singles && scopes.rarities.length === 0 && scopes.cards.length === 0) out.push({ ...base, ...blank, scope: "singles" });
  if (out.length === 0 && wholeSetWhenBare) out.push({ ...base, ...blank, scope: "set" });
  return out;
}

/**
 * Scoped statements in `text`. Each clause with a direction becomes a
 * statement for every scope it names (several products, grades, a rarity, a
 * card) in the set it names or the set named last before it. A clause with
 * scope words but no direction takes the direction of the next clause of the
 * same sentence that has one ("Booster boxes, ETBs, those are going down").
 * An "except ..." clause without its own direction marks its targets
 * "excluded". An "especially ..." clause takes the direction before it.
 */
export function extractScopeTalk(
  text: string,
  sets: ScopeSetIndex,
  cardIndex: CardNameIndex | null = null,
  publishedAt: Date | null = null,
): ScopeTalkStatement[] {
  if (!text || sets.names.size + sets.nicknames.size === 0) return [];
  const out: ScopeTalkStatement[] = [];
  const clauses = splitClauses(text);
  let current: ScopeSet[] = [];
  let currentSentence = -1;
  let grader: { name: string; sentence: number } | null = null;
  let lastDirection: { sentence: number; sentiment: ScopeSentiment } | null = null;
  let pending: Array<{ clause: Clause; scopes: Scopes; sets: ScopeSet[] }> = [];
  const flush = (sentiment: ScopeSentiment) => {
    for (const entry of pending) for (const set of entry.sets) out.push(...statementsFor(set, entry.scopes, sentiment, entry.clause, true, publishedAt, text));
    pending = [];
  };

  for (const clause of clauses) {
    if (out.length >= SCOPE_TALK_MAX_PER_TEXT) break;
    if (pending.length && pending[0]!.clause.sentence !== clause.sentence) pending = [];
    if (clause.sentence !== currentSentence) {
      if (current.length && clause.sentence - currentSentence > SET_CARRY_SENTENCES) current = [];
      if (lastDirection && lastDirection.sentence !== clause.sentence) lastDirection = null;
    }
    const found = findSets(clause.text, sets);
    if (found.sets.length) {
      current = found.sets;
      currentSentence = clause.sentence;
    }
    if (current.length === 0) continue;
    // A grader named in this or the previous sentence carries to bare grades ("PSA 10s are up. 9s are down.").
    const carried: string | null = grader && clause.sentence - grader.sentence <= 1 ? grader.name : null;
    const read = scopesOf(clause.text, cardIndex, carried, current);
    if (read.grader) grader = { name: read.grader, sentence: clause.sentence };
    const scopes = read.scopes;
    const direction = clauseDirection(clause.text);
    const namesSet = found.sets.length > 0;

    if (clause.exception) {
      const sentiment: ScopeSentiment = direction ?? "excluded";
      for (const set of current) out.push(...statementsFor(set, scopes, sentiment, clause, false, publishedAt, text));
      continue;
    }
    if (clause.emphasis && !direction) {
      const sentiment = lastDirection?.sentence === clause.sentence ? lastDirection.sentiment : null;
      if (sentiment) for (const set of current) out.push(...statementsFor(set, scopes, sentiment, clause, false, publishedAt, text));
      else if (hasScope(scopes)) pending.push({ clause, scopes: { ...scopes }, sets: current });
      continue;
    }
    if (!direction) {
      if (hasScope(scopes) || namesSet) pending.push({ clause, scopes, sets: current });
      continue;
    }
    if (pending.length) {
      flush(direction);
    }
    if (hasScope(scopes) || namesSet) {
      for (const set of current) out.push(...statementsFor(set, scopes, direction, clause, true, publishedAt, text));
    }
    lastDirection = { sentence: clause.sentence, sentiment: direction };
    if (namesSet) currentSentence = clause.sentence;
  }
  // Duplicates within one text (same target, same direction) count once.
  const seen = new Set<string>();
  return out
    .filter((row) => {
      const key = [row.setId, row.scope, row.productType, row.grade, row.rarity, row.cardName, row.sentiment].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, SCOPE_TALK_MAX_PER_TEXT);
}

// ---------------------------------------------------------------------------
// Time frames

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const COUNT_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12,
  couple: 2, "a couple": 2, "couple of": 2, "a couple of": 2, few: 3, "a few": 3, several: 4,
};
const UNIT_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };

export type TalkHorizon = {
  /** Days from the post the speaker gave the call ("until January", "next couple months"). */
  days: number;
  /** The words that set it, for the evidence trail. */
  phrase: string;
};

function daysUntil(from: Date, to: Date) {
  return Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000));
}

/** The first day of the next `month` (0-11) on or after `from`, at least two weeks away. */
function nextMonthStart(from: Date, month: number): Date {
  let year = from.getUTCFullYear();
  if (month < from.getUTCMonth() || (month === from.getUTCMonth() && from.getUTCDate() > 1)) year += 1;
  const start = new Date(Date.UTC(year, month, 1));
  return start.getTime() - from.getTime() < 14 * 86_400_000 ? new Date(Date.UTC(year + 1, month, 1)) : start;
}

/**
 * The time frame a speaker gives in `text`, as days from `publishedAt`:
 * "next couple months" (60), "over the next 3 weeks" (21), "until January"
 * (to the start of the next January), "by the end of the year" (to Dec 31),
 * "after the holidays" (to mid-January), "short term" (30), "long term"
 * (365). Null when the text gives none; such calls fade with age instead.
 */
export function parseTalkHorizon(text: string, publishedAt: Date): TalkHorizon | null {
  const lower = text.toLowerCase().replace(/[’]/g, "'");
  const span = lower.match(
    /\b(?:next|over\s+the\s+next|in\s+the\s+next|within\s+(?:the\s+next\s+)?|for\s+(?:the\s+next\s+)?|in|coming)\s+((?:a\s+)?couple(?:\s+of)?|(?:a\s+)?few|several|\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|twelve|a|an)?\s*(day|week|month|year)s?\b/,
  );
  if (span) {
    const raw = span[1]?.trim() ?? "1";
    const count = /^\d+$/.test(raw) ? Number(raw) : (COUNT_WORDS[raw] ?? 1);
    const days = Math.min(730, count * UNIT_DAYS[span[2]!]!);
    if (days > 0) return { days, phrase: span[0] };
  }
  const end = lower.match(/\b(?:end\s+of\s+(?:the\s+|this\s+)?year|year[\s-]end|by\s+christmas|before\s+christmas|through\s+the\s+holidays|holiday\s+season)\b/);
  if (end) {
    const year = publishedAt.getUTCMonth() === 11 && publishedAt.getUTCDate() > 15 ? publishedAt.getUTCFullYear() + 1 : publishedAt.getUTCFullYear();
    return { days: daysUntil(publishedAt, new Date(Date.UTC(year, 11, 31))), phrase: end[0] };
  }
  const afterHolidays = lower.match(/\bafter\s+(?:the\s+)?(?:holidays|christmas|new\s+year'?s?)\b/);
  if (afterHolidays) {
    const year = publishedAt.getUTCMonth() === 0 ? publishedAt.getUTCFullYear() + 1 : publishedAt.getUTCFullYear() + 1;
    return { days: daysUntil(publishedAt, new Date(Date.UTC(year, 0, 15))), phrase: afterHolidays[0] };
  }
  const monthRe = new RegExp(
    `\\b(?:until|till|til|'til|by|in|before|around|into|through|wait\\s+(?:for|until|till)?|until\\s+(?:at\\s+least|about)|end\\s+of|early|mid|late)\\s+(${MONTHS.join("|")}|${MONTH_ABBR.filter((m) => m !== "may" && m !== "mar").join("|")})\\b`,
  );
  const month = lower.match(monthRe);
  if (month) {
    const word = month[1]!;
    const index = MONTHS.indexOf(word) >= 0 ? MONTHS.indexOf(word) : MONTH_ABBR.indexOf(word);
    if (index >= 0) {
      let target = nextMonthStart(publishedAt, index);
      if (/\b(?:end\s+of|late|through)\s/.test(month[0])) target = new Date(Date.UTC(target.getUTCFullYear(), index + 1, 0));
      else if (/\bmid\s/.test(month[0])) target = new Date(Date.UTC(target.getUTCFullYear(), index, 15));
      return { days: daysUntil(publishedAt, target), phrase: month[0] };
    }
  }
  if (/\bnext\s+year\b/.test(lower)) return { days: 365, phrase: "next year" };
  if (/\b(?:short[\s-]term|right\s+now|for\s+now|this\s+week)\b/.test(lower)) return { days: /\bthis\s+week\b/.test(lower) ? 7 : 30, phrase: "short term" };
  if (/\blong[\s-]term\b/.test(lower)) return { days: 365, phrase: "long term" };
  return null;
}

/**
 * How much a statement still counts `ageDays` after it was posted. With a
 * time frame it counts fully until the frame ends, then stops (its result is
 * judged on the creator's record instead). Without one it counts fully for
 * the first 30 days, then fades linearly to nothing at 90 days: "it's going
 * down" means now, not forever.
 */
export const TALK_FULL_WEIGHT_DAYS = 30;
export const TALK_FADE_END_DAYS = 90;
export function talkAgeFactor(ageDays: number, horizonDays: number | null): number {
  if (ageDays < 0) return 0;
  if (horizonDays != null && horizonDays > 0) return ageDays <= horizonDays ? 1 : 0;
  if (ageDays <= TALK_FULL_WEIGHT_DAYS) return 1;
  if (ageDays >= TALK_FADE_END_DAYS) return 0;
  return 1 - (ageDays - TALK_FULL_WEIGHT_DAYS) / (TALK_FADE_END_DAYS - TALK_FULL_WEIGHT_DAYS);
}
