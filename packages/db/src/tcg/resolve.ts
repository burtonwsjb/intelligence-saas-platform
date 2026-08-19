import { and, eq } from "drizzle-orm";
import { tcgPrinting, tcgSet } from "../schema/tcg.js";
import type { Database } from "../client.js";
import { findTcgPrintingIdentifier, getTcgSet } from "./catalog.js";
import {
  isTcgLanguageCode,
  isTcgVariantKey,
  normalizeCollectorNumber,
  TcgValidationError,
} from "./identity.js";

export type TcgResolveQuery = {
  game?: string;
  set?: string;
  collector_number?: string;
  language?: string;
  variant?: string;
  external_id?: {
    source_namespace: string;
    identifier_type: string;
    identifier_value: string;
  };
};

export type TcgResolveResult = {
  status: "exact" | "ambiguous" | "not_found" | "conflict";
  confidence: number | null;
  printingId: string | null;
  candidates: string[];
};

export async function resolveTcgPrinting(
  db: Database,
  query: TcgResolveQuery,
): Promise<TcgResolveResult> {
  if (query.external_id) {
    const mapped = await findTcgPrintingIdentifier(db, {
      sourceNamespace: query.external_id.source_namespace,
      identifierType: query.external_id.identifier_type,
      normalizedValue: query.external_id.identifier_value.normalize("NFKC").trim().toLowerCase(),
    });
    if (!mapped) {
      return { status: "not_found", confidence: null, printingId: null, candidates: [] };
    }
    return {
      status: "exact",
      confidence: 1,
      printingId: mapped.printingId,
      candidates: [mapped.printingId],
    };
  }

  if (query.language == null || query.language === "") {
    throw new TcgValidationError("Language is required for exact printing resolution.");
  }
  if (!isTcgLanguageCode(query.language)) {
    throw new TcgValidationError("Language is required and must be a catalog BCP 47 code.");
  }
  if (!query.game || !query.set || !query.collector_number) {
    throw new TcgValidationError("game, set, collector_number, and language are required.");
  }

  const setRow = await getTcgSet(db, query.game, query.set);
  if (!setRow) {
    return { status: "not_found", confidence: null, printingId: null, candidates: [] };
  }
  const collector = normalizeCollectorNumber(query.collector_number);
  const filters = [
    eq(tcgPrinting.gameKey, query.game),
    eq(tcgPrinting.setId, setRow.id),
    eq(tcgPrinting.collectorNumberNormalized, collector),
    eq(tcgPrinting.languageCode, query.language),
  ];
  if (query.variant) {
    if (!isTcgVariantKey(query.variant)) {
      throw new TcgValidationError("Variant is required and must be a canonical variant key.");
    }
    filters.push(eq(tcgPrinting.variantKey, query.variant));
  }
  const rows = await db
    .select({ id: tcgPrinting.id })
    .from(tcgPrinting)
    .innerJoin(tcgSet, eq(tcgSet.id, tcgPrinting.setId))
    .where(and(...filters));
  const ids = [...new Set(rows.map((row) => row.id))];
  if (ids.length === 0) {
    return { status: "not_found", confidence: null, printingId: null, candidates: [] };
  }
  if (ids.length > 1) {
    return { status: "ambiguous", confidence: null, printingId: null, candidates: ids };
  }
  return { status: "exact", confidence: 1, printingId: ids[0]!, candidates: ids };
}
