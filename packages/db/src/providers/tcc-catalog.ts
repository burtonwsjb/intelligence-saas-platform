import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { providerSyncRun } from "../schema/provider.js";
import { tcgPrintingIdentifier } from "../schema/tcg.js";
import {
  getTcgSet,
  insertTcgCardConcept,
  insertTcgPrinting,
  insertTcgPrintingIdentifier,
  insertTcgSet,
} from "../tcg/catalog.js";
import { TCC_ID_TYPE, TCC_NAMESPACE } from "../tcg/fixtures.js";
import { isTcgVariantKey, normalizeTcgName, TcgIdentifierConflictError } from "../tcg/identity.js";
import { getProviderRuntime } from "./runtime.js";
import { createFetchTransport, ProviderHttpError, requireOkJson, type HttpTransport } from "./transport.js";

/** TCG Card Central's server-to-server card catalog feed (GET, Bearer TCC_API_TOKEN). */
export const TCC_CATALOG_PATH = "/api/public/integrations/social-signal/catalog";
/** Cards per request; the feed accepts at most 1000. */
export const TCC_CATALOG_PAGE_SIZE = 1000;
/** At most this many requests per run; a run resumes where the last one stopped. */
export const TCC_CATALOG_MAX_REQUESTS = 20;
/** After a full pass over every game, the next pass starts this long after it finished. */
export const TCC_CATALOG_RESWEEP_MS = 24 * 60 * 60 * 1000;
/** Our game keys and the codes TCC uses for them, in import order. */
export const TCC_CATALOG_GAMES = [
  { gameKey: "pokemon", tccGame: "pokemon" },
  { gameKey: "one_piece", tccGame: "onepiece" },
  { gameKey: "dragon_ball", tccGame: "dragonball" },
  { gameKey: "yugioh", tccGame: "yugioh" },
] as const;
type CatalogGameKey = (typeof TCC_CATALOG_GAMES)[number]["gameKey"];

/**
 * TCC language codes are en, es, zh, ja and ko. TCC's "zh" is not one script:
 * its Pokémon "zh" rows come from both TCGdex zh-cn (Simplified) and zh-tw
 * (Traditional) with nothing in the feed to tell them apart, so Pokémon "zh"
 * printings are skipped rather than mislabelled. One Piece "zh" comes from the
 * Hong Kong and Taiwan card lists and Dragon Ball "zh" from the asia-tc list,
 * both Traditional Chinese.
 */
const TCC_LANGUAGES: Record<string, string | Partial<Record<CatalogGameKey, string>>> = {
  en: "en",
  es: "es",
  ja: "ja",
  ko: "ko",
  zh: { one_piece: "zh-Hant", dragon_ball: "zh-Hant" },
};

/** Our language code for a TCC language on a game, or null when it cannot be told exactly. */
export function catalogLanguage(gameKey: string, tccLanguage: string): string | null {
  const mapped = TCC_LANGUAGES[tccLanguage.trim().toLowerCase()];
  if (typeof mapped === "string") return mapped;
  return mapped?.[gameKey as CatalogGameKey] ?? null;
}

const VARIANT_ALIASES: Record<string, string> = {
  "": "normal",
  normal: "normal",
  regular: "normal",
  standard: "normal",
  base: "normal",
  non_foil: "normal",
  nonfoil: "normal",
  holo: "holofoil",
  holofoil: "holofoil",
  foil: "holofoil",
  rare_holo: "holofoil",
  reverse: "reverse_holo",
  reverse_holo: "reverse_holo",
  reverse_holofoil: "reverse_holo",
  reverseholo: "reverse_holo",
  reverse_foil: "reverse_holo",
  parallel: "parallel",
  alt: "alt_art",
  alt_art: "alt_art",
  alternate_art: "alt_art",
  alternative_art: "alt_art",
  promo: "promo",
  promotional: "promo",
  "1st_edition": "first_edition",
  first_edition: "first_edition",
  unlimited: "unlimited",
  serialized: "serialized",
  numbered: "serialized",
  box_topper: "special_finish",
  manga: "special_finish",
  special: "special_finish",
  special_finish: "special_finish",
};

/**
 * TCC variants are free text (TCGdex finishes, Bandai parallel ids such as
 * "p1", One Piece "alternate_art", ...). Known values map onto our variant
 * keys; anything else is "normal". Two TCC cards that land on the same
 * printing are never merged: the second is skipped as a collision.
 */
export function catalogVariant(value: string | null | undefined): string {
  const key = (value ?? "").normalize("NFKC").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (/^p\d+$/.test(key) || /^parallel_?\d+$/.test(key)) return "parallel";
  const mapped = VARIANT_ALIASES[key];
  if (mapped) return mapped;
  return isTcgVariantKey(key) ? key : "normal";
}

/** TCC set codes as our set keys ("sv03.5" becomes "sv03-5"), or null if nothing usable is left. */
export function catalogSetKey(setCode: string): string | null {
  const key = setCode
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return /^[a-z0-9][a-z0-9_-]*$/.test(key) && key.length <= 64 ? key : null;
}

/**
 * Concept keys group printings by card name within a game ("Greninja ex"
 * becomes "greninja-ex", as in the fixtures). Names that would lose
 * characters in a plain slug (Japanese names, "Nidoran ♀") get a hash of the
 * full name so different names never share a concept.
 */
export function catalogConceptKey(name: string): string {
  const normalized = normalizeTcgName(name);
  const ascii = normalized.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const lossless = /^[A-Za-z0-9\s'’.,:&!?()-]*$/.test(ascii);
  if (slug && lossless) return slug;
  const hash = createHash("sha256").update(normalized.toLowerCase()).digest("hex").slice(0, 16);
  return slug ? `${slug}-${hash}` : `tcc-${hash}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Identifiers written by this import: "<TCC card id>:<language>". */
const IMPORTED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:/;

/** One printing per language, so the TCC card id is qualified by our language code. */
export function catalogIdentifierValue(tccCardId: string, language: string) {
  return `${tccCardId.toLowerCase()}:${language}`;
}

type CatalogCard = {
  id: string;
  name: string;
  collectorNumber: string;
  rarity: string | null;
  variantKey: string;
  languages: string[];
  unsupportedLanguages: number;
  set: { setKey: string; name: string; releaseDate: string | null };
};

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

function releaseDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const at = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== value ? null : value;
}

/** A feed row as an importable card, or null when it is malformed. */
export function parseCatalogCard(gameKey: string, raw: unknown): CatalogCard | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const set = row.set && typeof row.set === "object" ? (row.set as Record<string, unknown>) : null;
  const id = text(row.id, 64);
  const name = text(row.name, 200);
  const collectorNumber = text(row.card_number, 64);
  const setCode = text(set?.set_code, 64);
  const setKey = setCode ? catalogSetKey(setCode) : null;
  const setName = text(set?.name, 200);
  if (!id || !UUID.test(id) || !name || !collectorNumber || !setKey || !setName || !Array.isArray(row.languages)) {
    return null;
  }
  const languages = new Set<string>();
  let unsupportedLanguages = 0;
  for (const value of row.languages) {
    const language = typeof value === "string" ? catalogLanguage(gameKey, value) : null;
    if (language) languages.add(language);
    else unsupportedLanguages += 1;
  }
  return {
    id: id.toLowerCase(),
    name,
    collectorNumber,
    rarity: text(row.rarity, 100),
    variantKey: catalogVariant(typeof row.variant === "string" ? row.variant : null),
    languages: [...languages],
    unsupportedLanguages,
    set: { setKey, name: setName, releaseDate: releaseDate(set?.release_date) },
  };
}

type GameCursor = { after: string | null; done: boolean };
export type TccCatalogCheckpoint = {
  games: Record<CatalogGameKey, GameCursor>;
  sweep_started_at: string;
  sweep_completed_at: string | null;
};

function freshCheckpoint(now: Date): TccCatalogCheckpoint {
  const games = {} as Record<CatalogGameKey, GameCursor>;
  for (const { gameKey } of TCC_CATALOG_GAMES) games[gameKey] = { after: null, done: false };
  return { games, sweep_started_at: now.toISOString(), sweep_completed_at: null };
}

function readCheckpoint(value: unknown): TccCatalogCheckpoint | null {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const games = row?.games && typeof row.games === "object" ? (row.games as Record<string, unknown>) : null;
  if (!row || !games || typeof row.sweep_started_at !== "string") return null;
  const checkpoint = freshCheckpoint(new Date(row.sweep_started_at));
  for (const { gameKey } of TCC_CATALOG_GAMES) {
    const cursor = games[gameKey] as Partial<GameCursor> | undefined;
    checkpoint.games[gameKey] = {
      after: typeof cursor?.after === "string" && UUID.test(cursor.after) ? cursor.after : null,
      done: cursor?.done === true,
    };
  }
  checkpoint.sweep_completed_at = typeof row.sweep_completed_at === "string" ? row.sweep_completed_at : null;
  return checkpoint;
}

function sweepDone(checkpoint: TccCatalogCheckpoint) {
  return TCC_CATALOG_GAMES.every(({ gameKey }) => checkpoint.games[gameKey].done);
}

/** The checkpoint of the latest catalog run, which holds each game's cursor. */
export async function latestTccCatalogCheckpoint(db: Database): Promise<TccCatalogCheckpoint | null> {
  const [row] = await db
    .select({ checkpoint: providerSyncRun.checkpoint })
    .from(providerSyncRun)
    .where(
      and(
        eq(providerSyncRun.providerKey, "tcg_card_central"),
        eq(providerSyncRun.trigger, "catalog"),
        inArray(providerSyncRun.status, ["completed", "failed"]),
      ),
    )
    .orderBy(desc(providerSyncRun.startedAt), desc(providerSyncRun.completedAt))
    .limit(1);
  return row ? readCheckpoint(row.checkpoint) : null;
}

export type TccCatalogReport = {
  status: "completed" | "skipped" | "failed";
  reason: string | null;
  requests: number;
  /** Feed rows received. */
  cards: number;
  /** Printings newly tied to a TCC card id this run. */
  printings: number;
  sets: number;
  /** Card languages that were imported by an earlier run. */
  alreadyImported: number;
  malformed: number;
  /** Card languages skipped because our language for them is not certain (Pokémon "zh"). */
  unsupportedLanguage: number;
  /** Card languages whose printing already belongs to another card or TCC card id. */
  collisions: number;
  /** TCC card ids already bound to a different printing (recorded in tcg_identifier_conflict). */
  conflicts: number;
  /** Cards the database refused; the rest of the page is still imported. */
  rejected: number;
  sweepComplete: boolean;
};

type Caches = {
  sets: Map<string, { id: string; canonicalSetKey: string }>;
  concepts: Map<string, { id: string; conceptKey: string }>;
};

type Counts = Pick<TccCatalogReport, "printings" | "sets" | "collisions" | "conflicts">;

async function importCard(
  db: Database,
  gameKey: string,
  card: CatalogCard,
  languages: string[],
  caches: Caches,
): Promise<Counts & { cache: () => void }> {
  const counts: Counts = { printings: 0, sets: 0, collisions: 0, conflicts: 0 };
  const setCacheKey = `${gameKey}:${card.set.setKey}`;
  let set = caches.sets.get(setCacheKey);
  if (!set) {
    set = (await getTcgSet(db, gameKey, card.set.setKey)) ?? undefined;
    if (!set) {
      set = await insertTcgSet(db, {
        gameKey,
        canonicalSetKey: card.set.setKey,
        name: card.set.name,
        languageScope: card.languages.length === 1 ? card.languages[0] : "multi",
        releaseDate: card.set.releaseDate,
      });
      counts.sets += 1;
    }
  }
  const conceptKey = catalogConceptKey(card.name);
  const conceptCacheKey = `${gameKey}:${conceptKey}`;
  const concept =
    caches.concepts.get(conceptCacheKey) ??
    (await insertTcgCardConcept(db, { gameKey, conceptKey, canonicalName: card.name }));
  for (const language of languages) {
    const printing = (await insertTcgPrinting(db, {
      cardId: concept.id,
      setId: set.id,
      gameKey,
      conceptKey: concept.conceptKey,
      setKey: set.canonicalSetKey,
      collectorNumber: card.collectorNumber,
      language,
      variantKey: card.variantKey,
      rarity: card.rarity,
      promo: card.variantKey === "promo",
    })) as Awaited<ReturnType<typeof insertTcgPrinting>> | undefined;
    // Same set, number, language and variant as a printing of another card.
    if (!printing) {
      counts.collisions += 1;
      continue;
    }
    const owners = await db
      .select({ value: tcgPrintingIdentifier.normalizedValue })
      .from(tcgPrintingIdentifier)
      .where(
        and(
          eq(tcgPrintingIdentifier.printingId, printing.id),
          eq(tcgPrintingIdentifier.sourceNamespace, TCC_NAMESPACE),
          eq(tcgPrintingIdentifier.identifierType, TCC_ID_TYPE),
        ),
      );
    // Another TCC card already maps to this exact printing: never merge two cards.
    if (owners.some((row) => IMPORTED_ID.test(row.value) && !row.value.startsWith(`${card.id}:`))) {
      counts.collisions += 1;
      continue;
    }
    try {
      await insertTcgPrintingIdentifier(db, {
        printingId: printing.id,
        sourceNamespace: TCC_NAMESPACE,
        identifierType: TCC_ID_TYPE,
        identifierValue: catalogIdentifierValue(card.id, language),
      });
      counts.printings += 1;
    } catch (error) {
      if (!(error instanceof TcgIdentifierConflictError)) throw error;
      counts.conflicts += 1;
    }
  }
  const cachedSet = set;
  return {
    ...counts,
    // Only cached once the card's savepoint commits, so a rolled-back insert is never reused.
    cache: () => {
      caches.sets.set(setCacheKey, cachedSet);
      caches.concepts.set(conceptCacheKey, concept);
    },
  };
}

async function importPage(
  db: Database,
  gameKey: string,
  rows: unknown[],
  report: TccCatalogReport,
  caches: Caches,
) {
  const cards: CatalogCard[] = [];
  for (const raw of rows) {
    const card = parseCatalogCard(gameKey, raw);
    if (!card) {
      report.malformed += 1;
      continue;
    }
    report.unsupportedLanguage += card.unsupportedLanguages;
    if (card.languages.length > 0) cards.push(card);
  }
  const values = cards.flatMap((card) =>
    card.languages.map((language) => catalogIdentifierValue(card.id, language).toLowerCase()),
  );
  const imported = new Set(
    values.length
      ? (
          await db
            .select({ value: tcgPrintingIdentifier.normalizedValue })
            .from(tcgPrintingIdentifier)
            .where(
              and(
                eq(tcgPrintingIdentifier.sourceNamespace, TCC_NAMESPACE),
                eq(tcgPrintingIdentifier.identifierType, TCC_ID_TYPE),
                inArray(tcgPrintingIdentifier.normalizedValue, values),
              ),
            )
        ).map((row) => row.value)
      : [],
  );
  for (const card of cards) {
    const pending = card.languages.filter(
      (language) => !imported.has(catalogIdentifierValue(card.id, language).toLowerCase()),
    );
    report.alreadyImported += card.languages.length - pending.length;
    if (pending.length === 0) continue;
    try {
      // A savepoint per card: a row the database refuses skips that card only.
      const result = await db.transaction((tx) => importCard(tx as unknown as Database, gameKey, card, pending, caches));
      result.cache();
      report.printings += result.printings;
      report.sets += result.sets;
      report.collisions += result.collisions;
      report.conflicts += result.conflicts;
    } catch {
      report.rejected += 1;
    }
  }
}

type CatalogPage = { cards: unknown[]; nextAfter: string | null };

async function fetchCatalogPage(
  transport: HttpTransport,
  input: { baseUrl: string; token: string; tccGame: string; after: string | null; limit: number },
): Promise<CatalogPage> {
  const params = new URLSearchParams({ game: input.tccGame, limit: String(input.limit) });
  if (input.after) params.set("after", input.after);
  const response = await transport.fetch(`${input.baseUrl.replace(/\/$/, "")}${TCC_CATALOG_PATH}?${params}`, {
    method: "GET",
    headers: { accept: "application/json", authorization: `Bearer ${input.token}` },
  });
  return requireOkJson(response, (value) => {
    const body = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const nextAfter = body.next_after;
    if (
      body.ok !== true ||
      body.game !== input.tccGame ||
      !Array.isArray(body.cards) ||
      !(nextAfter === null || (typeof nextAfter === "string" && UUID.test(nextAfter))) ||
      (typeof nextAfter === "string" && nextAfter.toLowerCase() === input.after)
    ) {
      throw new ProviderHttpError({ status: response.status, errorClass: "invalid_payload" });
    }
    return { cards: body.cards, nextAfter: typeof nextAfter === "string" ? nextAfter.toLowerCase() : null };
  });
}

/**
 * Imports TCG Card Central's card catalog into the canonical TCG tables.
 * Pages through each game by card id, at most `maxRequests` requests per run
 * (TCC_CATALOG_MAX_REQUESTS), resuming from the cursor stored in the last
 * run's provider_sync_run checkpoint. After a full pass over every game, a
 * new pass starts at most once per TCC_CATALOG_RESWEEP_MS so new cards arrive.
 * Rows are only ever inserted through the idempotent catalog functions:
 * existing sets, cards, printings and identifiers are never changed. Each
 * supported language becomes its own printing. Malformed rows, uncertain
 * languages and identity collisions are skipped and counted.
 * With `exclusive`, call inside a transaction: another run holding the lock
 * makes this one skip.
 */
export async function importTccCatalog(
  db: Database,
  input: {
    baseUrl: string;
    token: string;
    transport?: HttpTransport;
    now?: Date;
    maxRequests?: number;
    pageSize?: number;
    exclusive?: boolean;
  },
): Promise<TccCatalogReport> {
  const now = input.now ?? new Date();
  const report: TccCatalogReport = {
    status: "completed",
    reason: null,
    requests: 0,
    cards: 0,
    printings: 0,
    sets: 0,
    alreadyImported: 0,
    malformed: 0,
    unsupportedLanguage: 0,
    collisions: 0,
    conflicts: 0,
    rejected: 0,
    sweepComplete: false,
  };
  const skipped = (reason: string, sweepComplete = false): TccCatalogReport => ({
    ...report,
    status: "skipped",
    reason,
    sweepComplete,
  });
  if (input.exclusive) {
    const result = await db.execute(sql`select pg_try_advisory_xact_lock(hashtext('tcc.catalog_import.v1')) as locked`);
    const rows = (Array.isArray(result) ? result : (result as { rows: { locked: boolean }[] }).rows) as { locked: boolean }[];
    if (!rows[0]?.locked) return skipped("overlap");
  }
  if ((await getProviderRuntime(db, "tcg_card_central"))?.paused) return skipped("paused");

  let checkpoint = await latestTccCatalogCheckpoint(db);
  if (checkpoint && sweepDone(checkpoint)) {
    const finished = checkpoint.sweep_completed_at ? Date.parse(checkpoint.sweep_completed_at) : Number.NaN;
    if (Number.isFinite(finished) && now.getTime() - finished < TCC_CATALOG_RESWEEP_MS) {
      return skipped("up_to_date", true);
    }
    checkpoint = null;
  }
  const state = checkpoint ?? freshCheckpoint(now);
  const maxRequests = Math.max(1, Math.min(input.maxRequests ?? TCC_CATALOG_MAX_REQUESTS, TCC_CATALOG_MAX_REQUESTS));
  const pageSize = Math.max(1, Math.min(input.pageSize ?? TCC_CATALOG_PAGE_SIZE, TCC_CATALOG_PAGE_SIZE));
  const transport = input.transport ?? createFetchTransport({ timeoutMs: 30_000 });
  const caches: Caches = { sets: new Map(), concepts: new Map() };

  try {
    for (const { gameKey, tccGame } of TCC_CATALOG_GAMES) {
      const cursor = state.games[gameKey];
      while (!cursor.done && report.requests < maxRequests) {
        report.requests += 1;
        const page = await fetchCatalogPage(transport, {
          baseUrl: input.baseUrl,
          token: input.token,
          tccGame,
          after: cursor.after,
          limit: pageSize,
        });
        report.cards += page.cards.length;
        await importPage(db, gameKey, page.cards, report, caches);
        if (page.nextAfter) cursor.after = page.nextAfter;
        else cursor.done = true;
      }
    }
  } catch (error) {
    // Pages imported before the failure keep their cursor; the next run resumes there.
    if (!(error instanceof ProviderHttpError)) throw error;
    report.status = "failed";
    report.reason = error.errorClass;
  }
  report.sweepComplete = sweepDone(state);
  if (report.sweepComplete && !state.sweep_completed_at) state.sweep_completed_at = now.toISOString();

  await db.insert(providerSyncRun).values({
    id: `psr_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    providerKey: "tcg_card_central",
    mode: "live",
    trigger: "catalog",
    status: report.status,
    limitCount: maxRequests,
    receivedCount: report.printings,
    quarantinedCount: report.malformed + report.collisions + report.conflicts + report.rejected,
    errorClass: report.reason,
    startedAt: now,
    completedAt: new Date(),
    checkpoint: state,
  });
  return report;
}
