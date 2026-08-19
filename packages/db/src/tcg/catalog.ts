import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  tcgCardConcept,
  tcgCardNameAlias,
  tcgGame,
  tcgIdentifierConflict,
  tcgLanguage,
  tcgPrinting,
  tcgPrintingIdentifier,
  tcgSet,
} from "../schema/tcg.js";
import type { Database } from "../client.js";
import {
  canonicalPrintingKey,
  normalizeCollectorNumber,
  normalizeTcgName,
  parseTcgLanguage,
  parseTcgVariant,
  TcgIdentifierConflictError,
  TcgValidationError,
} from "./identity.js";

function stableId(prefix: string, parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32)}`;
}

export async function listTcgGames(db: Database) {
  return db.select().from(tcgGame);
}

export async function getTcgGame(db: Database, gameKey: string) {
  const [row] = await db.select().from(tcgGame).where(eq(tcgGame.gameKey, gameKey)).limit(1);
  return row ?? null;
}

export async function listTcgLanguages(db: Database) {
  return db.select().from(tcgLanguage);
}

export async function insertTcgSet(
  db: Database,
  input: {
    gameKey: string;
    canonicalSetKey: string;
    name: string;
    languageScope?: string | null;
    releaseDate?: string | null;
  },
) {
  const id = stableId("set", [input.gameKey, input.canonicalSetKey]);
  await db
    .insert(tcgSet)
    .values({
      id,
      gameKey: input.gameKey,
      canonicalSetKey: input.canonicalSetKey,
      name: input.name,
      languageScope: input.languageScope,
      releaseDate: input.releaseDate,
    })
    .onConflictDoNothing();
  const [row] = await db
    .select()
    .from(tcgSet)
    .where(and(eq(tcgSet.gameKey, input.gameKey), eq(tcgSet.canonicalSetKey, input.canonicalSetKey)))
    .limit(1);
  return row!;
}

export async function insertTcgCardConcept(
  db: Database,
  input: { gameKey: string; conceptKey: string; canonicalName: string },
) {
  const id = stableId("crd", [input.gameKey, input.conceptKey]);
  await db
    .insert(tcgCardConcept)
    .values({
      id,
      gameKey: input.gameKey,
      conceptKey: input.conceptKey,
      canonicalName: input.canonicalName,
      normalizedName: normalizeTcgName(input.canonicalName),
    })
    .onConflictDoNothing();
  const [row] = await db
    .select()
    .from(tcgCardConcept)
    .where(
      and(eq(tcgCardConcept.gameKey, input.gameKey), eq(tcgCardConcept.conceptKey, input.conceptKey)),
    )
    .limit(1);
  return row!;
}

export async function insertTcgCardNameAlias(
  db: Database,
  input: { cardId: string; language: string; name: string },
) {
  const language = parseTcgLanguage(input.language);
  const normalizedName = normalizeTcgName(input.name);
  const id = stableId("nal", [input.cardId, language, normalizedName]);
  await db
    .insert(tcgCardNameAlias)
    .values({
      id,
      cardId: input.cardId,
      languageCode: language,
      name: input.name.trim(),
      normalizedName,
    })
    .onConflictDoNothing();
  const [row] = await db
    .select()
    .from(tcgCardNameAlias)
    .where(
      and(
        eq(tcgCardNameAlias.cardId, input.cardId),
        eq(tcgCardNameAlias.languageCode, language),
        eq(tcgCardNameAlias.normalizedName, normalizedName),
      ),
    )
    .limit(1);
  return row!;
}

export async function insertTcgPrinting(
  db: Database,
  input: {
    cardId: string;
    setId: string;
    gameKey: string;
    conceptKey: string;
    setKey: string;
    collectorNumber: string;
    language: string;
    variantKey: string;
    rarity?: string | null;
    finish?: string | null;
    edition?: string | null;
    promo?: boolean;
  },
) {
  const language = parseTcgLanguage(input.language);
  const variantKey = parseTcgVariant(input.variantKey);
  const collectorNumberNormalized = normalizeCollectorNumber(input.collectorNumber);
  if (!input.collectorNumber.trim()) {
    throw new TcgValidationError("collector_number is required.");
  }
  const key = canonicalPrintingKey({
    gameKey: input.gameKey,
    conceptKey: input.conceptKey,
    setKey: input.setKey,
    collectorNormalized: collectorNumberNormalized,
    language,
    variantKey,
  });
  const id = stableId("prn", [key]);
  await db
    .insert(tcgPrinting)
    .values({
      id,
      cardId: input.cardId,
      setId: input.setId,
      gameKey: input.gameKey,
      collectorNumber: input.collectorNumber.trim(),
      collectorNumberNormalized,
      languageCode: language,
      variantKey,
      rarity: input.rarity,
      finish: input.finish,
      edition: input.edition,
      promo: input.promo ?? false,
      canonicalPrintingKey: key,
    })
    .onConflictDoNothing();
  const [row] = await db
    .select()
    .from(tcgPrinting)
    .where(eq(tcgPrinting.canonicalPrintingKey, key))
    .limit(1);
  return row!;
}

export async function getTcgPrintingByKey(db: Database, canonicalPrintingKeyValue: string) {
  const [row] = await db
    .select()
    .from(tcgPrinting)
    .where(eq(tcgPrinting.canonicalPrintingKey, canonicalPrintingKeyValue))
    .limit(1);
  return row ?? null;
}

export async function getTcgSet(db: Database, gameKey: string, canonicalSetKey: string) {
  const [row] = await db
    .select()
    .from(tcgSet)
    .where(and(eq(tcgSet.gameKey, gameKey), eq(tcgSet.canonicalSetKey, canonicalSetKey)))
    .limit(1);
  return row ?? null;
}

export async function findTcgPrintingIdentifier(
  db: Database,
  input: { sourceNamespace: string; identifierType: string; normalizedValue: string },
) {
  const [row] = await db
    .select()
    .from(tcgPrintingIdentifier)
    .where(
      and(
        eq(tcgPrintingIdentifier.sourceNamespace, input.sourceNamespace),
        eq(tcgPrintingIdentifier.identifierType, input.identifierType),
        eq(tcgPrintingIdentifier.normalizedValue, input.normalizedValue),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function insertTcgPrintingIdentifier(
  db: Database,
  input: {
    printingId: string;
    sourceNamespace: string;
    identifierType: string;
    identifierValue: string;
  },
) {
  const normalizedValue = input.identifierValue.normalize("NFKC").trim().toLowerCase();
  const existing = await findTcgPrintingIdentifier(db, {
    sourceNamespace: input.sourceNamespace,
    identifierType: input.identifierType,
    normalizedValue,
  });
  if (existing) {
    if (existing.printingId !== input.printingId) {
      await db.insert(tcgIdentifierConflict).values({
        id: crypto.randomUUID(),
        sourceNamespace: input.sourceNamespace,
        identifierType: input.identifierType,
        normalizedValue,
        existingPrintingId: existing.printingId,
        attemptedPrintingId: input.printingId,
      });
      throw new TcgIdentifierConflictError();
    }
    return existing;
  }
  const id = stableId("tid", [input.sourceNamespace, input.identifierType, normalizedValue]);
  await db.insert(tcgPrintingIdentifier).values({
    id,
    printingId: input.printingId,
    sourceNamespace: input.sourceNamespace,
    identifierType: input.identifierType,
    identifierValue: input.identifierValue,
    normalizedValue,
  });
  return findTcgPrintingIdentifier(db, {
    sourceNamespace: input.sourceNamespace,
    identifierType: input.identifierType,
    normalizedValue,
  });
}

export async function listTcgIdentifierConflicts(db: Database) {
  return db.select().from(tcgIdentifierConflict);
}
