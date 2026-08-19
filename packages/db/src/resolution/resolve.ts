import { eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { tcgCardConcept, tcgCardNameAlias, tcgPrinting, tcgSet } from "../schema/tcg.js";
import { findTcgPrintingIdentifier } from "../tcg/catalog.js";
import {
  FUZZY_HIGH_THRESHOLD,
  FUZZY_PROBABLE_THRESHOLD,
  collectorMatches,
  nameSimilarity,
  normalizeMatchText,
  optionalSignal,
  type ResolutionSignals,
  type ScoredCandidate,
} from "./identity.js";
import { inferSignalsFromText, mergeSignals, type CatalogHints } from "./signals.js";
import {
  persistResolution,
  getSourceMentionRecord,
  type PersistedResolution,
} from "./persist.js";
import type { EntityResolutionState, EntityResolutionSubjectType } from "./identity.js";

type CatalogPrinting = {
  printingId: string;
  conceptId: string;
  gameKey: string;
  setKey: string;
  setName: string;
  collectorNormalized: string;
  languageCode: string;
  variantKey: string;
  rarity: string | null;
  finish: string | null;
  promo: boolean;
  canonicalName: string;
};

type CatalogAlias = {
  cardId: string;
  languageCode: string;
  name: string;
  normalizedName: string;
};

type Catalog = {
  printings: CatalogPrinting[];
  aliases: CatalogAlias[];
  hints: CatalogHints;
};

const ATTR_SCORE = {
  external_id: 100,
  game: 20,
  set: 40,
  collector: 40,
  language: 40,
  variant: 30,
  name_exact: 25,
  name_fuzzy: 15,
  rarity: 8,
  finish: 8,
  promo: 5,
  content_language_hint: 8,
  context_clue: 4,
} as const;

async function loadCatalog(db: Database, game?: string): Promise<Catalog> {
  const printingRows = await db
    .select({
      printingId: tcgPrinting.id,
      conceptId: tcgPrinting.cardId,
      gameKey: tcgPrinting.gameKey,
      setKey: tcgSet.canonicalSetKey,
      setName: tcgSet.name,
      collectorNormalized: tcgPrinting.collectorNumberNormalized,
      languageCode: tcgPrinting.languageCode,
      variantKey: tcgPrinting.variantKey,
      rarity: tcgPrinting.rarity,
      finish: tcgPrinting.finish,
      promo: tcgPrinting.promo,
      canonicalName: tcgCardConcept.canonicalName,
    })
    .from(tcgPrinting)
    .innerJoin(tcgSet, eq(tcgSet.id, tcgPrinting.setId))
    .innerJoin(tcgCardConcept, eq(tcgCardConcept.id, tcgPrinting.cardId));
  const aliases = await db.select().from(tcgCardNameAlias);
  const setRows = await db.select({ canonicalSetKey: tcgSet.canonicalSetKey, name: tcgSet.name }).from(tcgSet);
  const printings = game ? printingRows.filter((row) => row.gameKey === game) : printingRows;
  return {
    printings,
    aliases: aliases.map((row) => ({
      cardId: row.cardId,
      languageCode: row.languageCode,
      name: row.name,
      normalizedName: row.normalizedName,
    })),
    hints: {
      sets: setRows,
      names: [...new Set(printings.map((row) => row.canonicalName))],
    },
  };
}

function setMatches(signal: string, printing: CatalogPrinting): boolean {
  const value = normalizeMatchText(signal);
  return value === normalizeMatchText(printing.setKey) || value === normalizeMatchText(printing.setName);
}

function bestNameMatch(
  query: string | undefined,
  printing: CatalogPrinting,
  aliases: CatalogAlias[],
): { similarity: number; exact: boolean; aliasLanguage?: string } {
  if (!query) {
    return { similarity: 0, exact: false };
  }
  const names = [
    { name: printing.canonicalName, language: undefined as string | undefined },
    ...aliases
      .filter((alias) => alias.cardId === printing.conceptId)
      .map((alias) => ({ name: alias.name, language: alias.languageCode })),
  ];
  let best = { similarity: 0, exact: false, aliasLanguage: undefined as string | undefined };
  for (const entry of names) {
    const similarity = nameSimilarity(query, entry.name);
    const exact = normalizeMatchText(query) === normalizeMatchText(entry.name);
    if (exact || similarity > best.similarity) {
      best = { similarity: exact ? 1 : similarity, exact, aliasLanguage: entry.language };
    }
  }
  return best;
}

function scorePrinting(
  printing: CatalogPrinting,
  signals: ResolutionSignals,
  aliases: CatalogAlias[],
): ScoredCandidate {
  const matched: string[] = [];
  const conflicting: string[] = [];
  const evidence: string[] = [];
  let score = 0;
  const nameQuery = optionalSignal(signals.card_name);

  const check = (
    provided: string | undefined,
    ok: boolean,
    attr: string,
    evidenceCode: string,
    points: number,
  ) => {
    if (!provided) {
      return;
    }
    if (ok) {
      matched.push(attr);
      evidence.push(evidenceCode);
      score += points;
    } else {
      conflicting.push(attr);
      evidence.push("conflicting_attribute");
      score -= 80;
    }
  };

  check(optionalSignal(signals.game), optionalSignal(signals.game) === printing.gameKey, "game", "game_exact", ATTR_SCORE.game);
  check(optionalSignal(signals.set), setMatches(signals.set ?? "", printing), "set", "set_exact", ATTR_SCORE.set);
  check(
    optionalSignal(signals.collector_number),
    collectorMatches(signals.collector_number ?? "", printing.collectorNormalized),
    "collector",
    "collector_exact",
    ATTR_SCORE.collector,
  );
  check(
    optionalSignal(signals.language),
    signals.language === printing.languageCode,
    "language",
    "language_exact",
    ATTR_SCORE.language,
  );
  check(
    optionalSignal(signals.variant),
    signals.variant === printing.variantKey,
    "variant",
    "variant_exact",
    ATTR_SCORE.variant,
  );
  if (optionalSignal(signals.rarity)) {
    check(signals.rarity ?? undefined, (signals.rarity ?? null) === printing.rarity, "rarity", "rarity_exact", ATTR_SCORE.rarity);
  }
  if (optionalSignal(signals.finish)) {
    check(signals.finish ?? undefined, (signals.finish ?? null) === printing.finish, "finish", "finish_exact", ATTR_SCORE.finish);
  }
  if (signals.promo != null) {
    check(String(signals.promo), signals.promo === printing.promo, "promo", "promo_exact", ATTR_SCORE.promo);
  }

  const name = bestNameMatch(nameQuery, printing, aliases);
  if (name.exact) {
    matched.push("name");
    evidence.push("name_exact");
    score += ATTR_SCORE.name_exact;
    if (name.aliasLanguage) {
      evidence.push("name_language_alias");
    }
  } else if (name.similarity >= FUZZY_PROBABLE_THRESHOLD) {
    matched.push("name");
    evidence.push("name_similarity");
    score += ATTR_SCORE.name_fuzzy * name.similarity;
  }

  if (signals.content_language && signals.content_language === printing.languageCode) {
    evidence.push("content_language_hint");
    score += ATTR_SCORE.content_language_hint;
  }
  if (optionalSignal(signals.context_text) && (matched.includes("set") || matched.includes("collector"))) {
    evidence.push("context_clue");
    score += ATTR_SCORE.context_clue;
  }

  return {
    printingId: printing.printingId,
    conceptId: printing.conceptId,
    score,
    matched,
    conflicting,
    evidence: [...new Set(evidence)],
    nameSimilarity: name.similarity,
  };
}

function hardFilter(printings: CatalogPrinting[], signals: ResolutionSignals): CatalogPrinting[] {
  return printings.filter((printing) => {
    if (optionalSignal(signals.game) && signals.game !== printing.gameKey) {
      return false;
    }
    if (optionalSignal(signals.set) && !setMatches(signals.set!, printing)) {
      return false;
    }
    if (
      optionalSignal(signals.collector_number) &&
      !collectorMatches(signals.collector_number!, printing.collectorNormalized)
    ) {
      return false;
    }
    if (optionalSignal(signals.language) && signals.language !== printing.languageCode) {
      return false;
    }
    if (optionalSignal(signals.variant) && signals.variant !== printing.variantKey) {
      return false;
    }
    return true;
  });
}

function uniqueValues(values: string[]): number {
  return new Set(values).size;
}

function decideStatus(
  signals: ResolutionSignals,
  pool: CatalogPrinting[],
  ranked: ScoredCandidate[],
  exactExternal: CatalogPrinting | null,
  structuredComplete: boolean,
): {
  status: EntityResolutionState;
  chosenPrintingId: string | null;
  chosenConceptId: string | null;
  targetLayer: "printing" | "concept" | "generic_entity";
  confidence: number | null;
} {
  if (ranked.some((row) => row.conflicting.length > 0) && exactExternal) {
    const conflicted = ranked.filter((row) => row.conflicting.length > 0 && row.printingId === exactExternal.printingId);
    if (conflicted.length > 0) {
      return {
        status: "conflict",
        chosenPrintingId: null,
        chosenConceptId: exactExternal.conceptId,
        targetLayer: "printing",
        confidence: null,
      };
    }
  }

  if (exactExternal && pool.some((row) => row.printingId === exactExternal.printingId) && ranked[0]?.conflicting.length === 0) {
    return {
      status: "exact",
      chosenPrintingId: exactExternal.printingId,
      chosenConceptId: exactExternal.conceptId,
      targetLayer: "printing",
      confidence: 1,
    };
  }

  if (pool.length === 0) {
    const fuzzy = ranked.filter((row) => row.nameSimilarity >= FUZZY_PROBABLE_THRESHOLD && row.conflicting.length === 0);
    const concepts = new Set(fuzzy.map((row) => row.conceptId));
    if (concepts.size === 1) {
      return {
        status: "probable",
        chosenPrintingId: null,
        chosenConceptId: [...concepts][0]!,
        targetLayer: "concept",
        confidence: 0.6,
      };
    }
    return {
      status: "unresolved",
      chosenPrintingId: null,
      chosenConceptId: null,
      targetLayer: "concept",
      confidence: null,
    };
  }

  const languagesInPool = uniqueValues(pool.map((row) => row.languageCode));
  const variantsInPool = uniqueValues(pool.map((row) => row.variantKey));
  const conceptsInPool = uniqueValues(pool.map((row) => row.conceptId));
  const languageMissing = !optionalSignal(signals.language);
  const variantMissing = !optionalSignal(signals.variant);
  const uniqueConcept = conceptsInPool === 1 ? pool[0]!.conceptId : null;
  const hasHardIdentity = Boolean(
    optionalSignal(signals.set) ||
      optionalSignal(signals.collector_number) ||
      optionalSignal(signals.language) ||
      optionalSignal(signals.variant) ||
      signals.external_id,
  );

  if (!hasHardIdentity && uniqueConcept) {
    const bestName = Math.max(
      0,
      ...pool.map((row) => ranked.find((candidate) => candidate.printingId === row.printingId)?.nameSimilarity ?? 0),
    );
    if (bestName < 1 && bestName >= FUZZY_PROBABLE_THRESHOLD) {
      return {
        status: "probable",
        chosenPrintingId: null,
        chosenConceptId: uniqueConcept,
        targetLayer: "concept",
        confidence: 0.62,
      };
    }
    return {
      status: "ambiguous",
      chosenPrintingId: null,
      chosenConceptId: uniqueConcept,
      targetLayer: "concept",
      confidence: null,
    };
  }

  if (languageMissing && languagesInPool > 1) {
    return {
      status: "ambiguous",
      chosenPrintingId: null,
      chosenConceptId: uniqueConcept,
      targetLayer: uniqueConcept ? "concept" : "printing",
      confidence: null,
    };
  }
  if (variantMissing && variantsInPool > 1) {
    return {
      status: "ambiguous",
      chosenPrintingId: null,
      chosenConceptId: uniqueConcept,
      targetLayer: uniqueConcept ? "concept" : "printing",
      confidence: null,
    };
  }

  if (pool.length === 1) {
    const only = pool[0]!;
    const name = ranked.find((row) => row.printingId === only.printingId);
    const nameWasFuzzy = Boolean(optionalSignal(signals.card_name)) && (name?.nameSimilarity ?? 0) < 1 && (name?.nameSimilarity ?? 0) >= FUZZY_HIGH_THRESHOLD;
    if (structuredComplete) {
      return {
        status: "exact",
        chosenPrintingId: only.printingId,
        chosenConceptId: only.conceptId,
        targetLayer: "printing",
        confidence: 1,
      };
    }
    if (nameWasFuzzy) {
      return {
        status: "high_confidence",
        chosenPrintingId: only.printingId,
        chosenConceptId: only.conceptId,
        targetLayer: "printing",
        confidence: 0.86,
      };
    }
    return {
      status: "exact",
      chosenPrintingId: only.printingId,
      chosenConceptId: only.conceptId,
      targetLayer: "printing",
      confidence: 1,
    };
  }

  const clean = ranked.filter((row) => row.conflicting.length === 0 && pool.some((p) => p.printingId === row.printingId));
  const top = clean[0];
  const second = clean[1];
  if (!top) {
    return {
      status: "unresolved",
      chosenPrintingId: null,
      chosenConceptId: uniqueConcept,
      targetLayer: uniqueConcept ? "concept" : "printing",
      confidence: null,
    };
  }
  const gap = top.score - (second?.score ?? 0);
  const fuzzyOnly = optionalSignal(signals.card_name) && top.nameSimilarity < 1 && top.nameSimilarity >= FUZZY_HIGH_THRESHOLD;
  if (
    structuredComplete === false &&
    fuzzyOnly &&
    gap >= 20 &&
    optionalSignal(signals.language) &&
    optionalSignal(signals.variant)
  ) {
    return {
      status: "high_confidence",
      chosenPrintingId: top.printingId,
      chosenConceptId: top.conceptId,
      targetLayer: "printing",
      confidence: 0.86,
    };
  }
  if (top.nameSimilarity >= FUZZY_PROBABLE_THRESHOLD && top.nameSimilarity < 1 && !optionalSignal(signals.set)) {
    return {
      status: "probable",
      chosenPrintingId: null,
      chosenConceptId: uniqueConcept ?? top.conceptId,
      targetLayer: "concept",
      confidence: 0.62,
    };
  }
  return {
    status: "ambiguous",
    chosenPrintingId: null,
    chosenConceptId: uniqueConcept,
    targetLayer: uniqueConcept ? "concept" : "printing",
    confidence: null,
  };
}

export async function resolveEntity(
  db: Database,
  input: {
    subjectType: EntityResolutionSubjectType;
    subjectId: string;
    mentionId?: string | null;
    signals: ResolutionSignals;
  },
): Promise<PersistedResolution> {
  const catalog = await loadCatalog(db, optionalSignal(input.signals.game));
  const contextText = [
    optionalSignal(input.signals.context_text),
    optionalSignal(input.signals.card_name),
  ]
    .filter(Boolean)
    .join(" ");
  const inferred = contextText ? inferSignalsFromText(contextText, catalog.hints) : {};
  const signals = mergeSignals(input.signals, inferred);

  let exactExternal: CatalogPrinting | null = null;
  if (signals.external_id) {
    const mapped = await findTcgPrintingIdentifier(db, {
      sourceNamespace: signals.external_id.source_namespace,
      identifierType: signals.external_id.identifier_type,
      normalizedValue: signals.external_id.identifier_value.normalize("NFKC").trim().toLowerCase(),
    });
    if (mapped) {
      exactExternal = catalog.printings.find((row) => row.printingId === mapped.printingId) ?? null;
    }
  }

  const hardPool = hardFilter(catalog.printings, signals);
  const structuredComplete = Boolean(
    optionalSignal(signals.game) &&
      optionalSignal(signals.set) &&
      optionalSignal(signals.collector_number) &&
      optionalSignal(signals.language) &&
      optionalSignal(signals.variant),
  );
  const hasHardIdentity = Boolean(
    optionalSignal(signals.set) ||
      optionalSignal(signals.collector_number) ||
      optionalSignal(signals.language) ||
      optionalSignal(signals.variant) ||
      signals.external_id,
  );

  const scoreOne = (printing: CatalogPrinting): ScoredCandidate => {
    const candidate = scorePrinting(printing, signals, catalog.aliases);
    if (exactExternal && printing.printingId === exactExternal.printingId && candidate.conflicting.length === 0) {
      candidate.score += ATTR_SCORE.external_id;
      candidate.evidence = [...new Set([...candidate.evidence, "external_id_exact"])];
      candidate.matched = [...new Set([...candidate.matched, "external_id"])];
    }
    if (exactExternal && printing.printingId === exactExternal.printingId && candidate.conflicting.length > 0) {
      candidate.evidence = [...new Set([...candidate.evidence, "external_id_exact", "conflicting_attribute"])];
    }
    return candidate;
  };

  const universe = new Map<string, CatalogPrinting>();
  for (const printing of hardPool) {
    universe.set(printing.printingId, printing);
  }
  if (exactExternal) {
    universe.set(exactExternal.printingId, exactExternal);
  }
  if (universe.size === 0) {
    for (const printing of catalog.printings) {
      universe.set(printing.printingId, printing);
    }
  }

  const scored = [...universe.values()].map(scoreOne);
  scored.sort((a, b) => b.score - a.score || a.printingId.localeCompare(b.printingId));

  if (exactExternal) {
    const inHardPool = hardPool.some((row) => row.printingId === exactExternal.printingId);
    const externalScored = scored.find((row) => row.printingId === exactExternal.printingId);
    if (!inHardPool && hasHardIdentity) {
      return persistResolution(db, {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        mentionId: input.mentionId,
        status: "conflict",
        targetLayer: "printing",
        chosenPrintingId: null,
        chosenConceptId: exactExternal.conceptId,
        confidence: null,
        signals,
        candidates: scored.filter((row) => row.score > 0 || row.conflicting.length > 0).slice(0, 12),
      });
    }
    if (externalScored && externalScored.conflicting.length > 0) {
      return persistResolution(db, {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        mentionId: input.mentionId,
        status: "conflict",
        targetLayer: "printing",
        chosenPrintingId: null,
        chosenConceptId: exactExternal.conceptId,
        confidence: null,
        signals,
        candidates: scored.filter((row) => row.score > 0 || row.conflicting.length > 0).slice(0, 12),
      });
    }
  }

  let pool = hardPool;
  const nameQuery = optionalSignal(signals.card_name);
  if (nameQuery) {
    const named = pool.filter((printing) => {
      const row = scored.find((candidate) => candidate.printingId === printing.printingId);
      return (row?.nameSimilarity ?? 0) >= FUZZY_PROBABLE_THRESHOLD;
    });
    if (named.length > 0) {
      pool = named;
    } else if (!hasHardIdentity) {
      const namedAll = catalog.printings.filter((printing) => {
        const row = scoreOne(printing);
        return row.nameSimilarity >= FUZZY_PROBABLE_THRESHOLD;
      });
      pool = namedAll;
      for (const printing of namedAll) {
        if (!scored.some((row) => row.printingId === printing.printingId)) {
          scored.push(scoreOne(printing));
        }
      }
      scored.sort((a, b) => b.score - a.score || a.printingId.localeCompare(b.printingId));
    }
  } else if (!hasHardIdentity) {
    pool = [];
  }

  const decision = decideStatus(signals, pool, scored, exactExternal, structuredComplete);
  const candidates = scored
    .filter((row) => row.score > 0 || row.conflicting.length > 0 || pool.some((p) => p.printingId === row.printingId))
    .slice(0, 12);

  return persistResolution(db, {
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    mentionId: input.mentionId,
    status: decision.status,
    targetLayer: decision.targetLayer,
    chosenPrintingId: decision.chosenPrintingId,
    chosenConceptId: decision.chosenConceptId,
    confidence: decision.confidence,
    reviewState: decision.status === "ambiguous" || decision.status === "probable" ? "needs_review" : "none",
    signals,
    candidates,
  });
}

export async function resolveSourceMention(db: Database, mentionId: string): Promise<PersistedResolution> {
  const record = await getSourceMentionRecord(db, mentionId);
  if (!record) {
    throw new Error("source mention not found.");
  }
  const context = [
    record.mention.rawEntityText,
    record.content?.title,
    record.content?.summary,
  ]
    .filter(Boolean)
    .join(" ");
  return resolveEntity(db, {
    subjectType: "mention",
    subjectId: mentionId,
    mentionId,
    signals: {
      card_name: record.mention.normalizedEntityText,
      context_text: context,
      content_language: record.content?.language ?? null,
    },
  });
}
