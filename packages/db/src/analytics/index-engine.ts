import { and, asc, desc, eq, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { tcgIndexDefinition, tcgIndexLevel, tcgIndexMembership } from "../schema/analytics.js";
import { tcgMarketSnapshot } from "../schema/tcg-market.js";
import { tcgCardConcept, tcgPrinting, tcgSet } from "../schema/tcg.js";
import {
  DEFAULT_INDEX_WEIGHTING,
  INDEX_BASE_VALUE,
  INDEX_METHOD_VERSION,
  MS_DAY,
  type IndexWeightingMethod,
} from "./catalog.js";

export type IndexMembershipRule = {
  game_key: string;
  language_code?: string | null;
  concept_key?: string | null;
  set_key?: string | null;
  era?: string | null;
  variant_key?: string | null;
  condition?: string;
  raw_graded?: "raw" | "graded" | "psa10";
  min_sales_30d?: number;
  min_history_observations?: number;
  allow_mixed_languages?: boolean;
};

export type UpsertIndexDefinitionInput = {
  indexKey: string;
  name: string;
  gameKey: string;
  languageCode?: string | null;
  membershipRule: IndexMembershipRule;
  weightingMethod?: IndexWeightingMethod;
  minLiquidity?: number;
  minHistory?: number;
  rebalanceSchedule?: string;
  methodVersion?: string;
  status?: string;
};

const MODERN_SET_KEYS = new Set(["sv1", "sv2", "svp", "twm"]);

function asRule(value: Record<string, unknown>): IndexMembershipRule {
  return {
    game_key: String(value.game_key ?? ""),
    language_code: (value.language_code as string | null | undefined) ?? null,
    concept_key: (value.concept_key as string | null | undefined) ?? null,
    set_key: (value.set_key as string | null | undefined) ?? null,
    era: (value.era as string | null | undefined) ?? null,
    variant_key: (value.variant_key as string | null | undefined) ?? null,
    condition: (value.condition as string | undefined) ?? "nm",
    raw_graded: (value.raw_graded as IndexMembershipRule["raw_graded"]) ?? "raw",
    min_sales_30d: typeof value.min_sales_30d === "number" ? value.min_sales_30d : 1,
    min_history_observations:
      typeof value.min_history_observations === "number" ? value.min_history_observations : 1,
    allow_mixed_languages: value.allow_mixed_languages === true,
  };
}

export async function upsertIndexDefinition(db: Database, input: UpsertIndexDefinitionInput) {
  const existing = await getIndexDefinition(db, input.indexKey);
  if (existing) {
    return existing;
  }
  const language = input.languageCode ?? input.membershipRule.language_code ?? null;
  if (!language && input.membershipRule.allow_mixed_languages !== true) {
    throw new Error("index.v1 requires language_code unless allow_mixed_languages is explicitly true.");
  }
  const [row] = await db
    .insert(tcgIndexDefinition)
    .values({
      indexKey: input.indexKey,
      name: input.name,
      gameKey: input.gameKey,
      languageCode: language,
      membershipRule: input.membershipRule,
      weightingMethod: input.weightingMethod ?? DEFAULT_INDEX_WEIGHTING,
      minLiquidity: input.minLiquidity ?? input.membershipRule.min_sales_30d ?? 1,
      minHistory: input.minHistory ?? input.membershipRule.min_history_observations ?? 1,
      rebalanceSchedule: input.rebalanceSchedule ?? "manual",
      methodVersion: input.methodVersion ?? INDEX_METHOD_VERSION,
      status: input.status ?? "active",
    })
    .returning();
  return row!;
}

export async function getIndexDefinition(db: Database, indexKey: string) {
  const [row] = await db.select().from(tcgIndexDefinition).where(eq(tcgIndexDefinition.indexKey, indexKey)).limit(1);
  return row ?? null;
}

export async function listIndexDefinitions(db: Database, filter?: { gameKey?: string; languageCode?: string }) {
  const rows = await db.select().from(tcgIndexDefinition);
  return rows.filter((row) => {
    if (filter?.gameKey && row.gameKey !== filter.gameKey) {
      return false;
    }
    if (filter?.languageCode && row.languageCode !== filter.languageCode) {
      return false;
    }
    return true;
  });
}

async function soldPriceAsOf(
  db: Database,
  input: { printingId: string; asOf: Date; condition: string; rawGraded: IndexMembershipRule["raw_graded"] },
): Promise<number | null> {
  const clauses = [
    eq(tcgMarketSnapshot.printingId, input.printingId),
    eq(tcgMarketSnapshot.priceType, "sold"),
    eq(tcgMarketSnapshot.condition, input.condition),
    lte(tcgMarketSnapshot.observedAt, input.asOf),
  ];
  if (input.rawGraded === "raw") {
    clauses.push(isNull(tcgMarketSnapshot.gradingCompany));
  } else if (input.rawGraded === "psa10") {
    clauses.push(eq(tcgMarketSnapshot.gradingCompany, "psa"));
    clauses.push(eq(tcgMarketSnapshot.gradeLabel, "10"));
  }
  const [row] = await db
    .select()
    .from(tcgMarketSnapshot)
    .where(and(...clauses))
    .orderBy(desc(tcgMarketSnapshot.observedAt))
    .limit(1);
  return row?.price == null ? null : Number(row.price);
}

async function salesCountAsOf(db: Database, printingId: string, asOf: Date, days: number, condition: string) {
  const from = new Date(asOf.getTime() - days * MS_DAY);
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(tcgMarketSnapshot)
    .where(
      and(
        eq(tcgMarketSnapshot.printingId, printingId),
        eq(tcgMarketSnapshot.priceType, "sold"),
        eq(tcgMarketSnapshot.condition, condition),
        lte(tcgMarketSnapshot.observedAt, asOf),
        sql`${tcgMarketSnapshot.observedAt} > ${from}`,
        isNull(tcgMarketSnapshot.gradingCompany),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

async function historyCountAsOf(db: Database, printingId: string, asOf: Date, condition: string) {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(tcgMarketSnapshot)
    .where(
      and(
        eq(tcgMarketSnapshot.printingId, printingId),
        eq(tcgMarketSnapshot.priceType, "sold"),
        eq(tcgMarketSnapshot.condition, condition),
        lte(tcgMarketSnapshot.observedAt, asOf),
        isNull(tcgMarketSnapshot.gradingCompany),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

export async function qualifyIndexMembers(db: Database, indexKey: string, asOf: Date) {
  const definition = await getIndexDefinition(db, indexKey);
  if (!definition) {
    throw new Error(`index ${indexKey} not found.`);
  }
  const rule = asRule(definition.membershipRule);
  if (!rule.language_code && rule.allow_mixed_languages !== true) {
    return [];
  }
  const printings = await db
    .select({
      id: tcgPrinting.id,
      gameKey: tcgPrinting.gameKey,
      languageCode: tcgPrinting.languageCode,
      conceptKey: tcgCardConcept.conceptKey,
      variantKey: tcgPrinting.variantKey,
      setKey: tcgSet.canonicalSetKey,
    })
    .from(tcgPrinting)
    .innerJoin(tcgSet, eq(tcgSet.id, tcgPrinting.setId))
    .innerJoin(tcgCardConcept, eq(tcgCardConcept.id, tcgPrinting.cardId));

  const qualified: { printingId: string; sales30d: number }[] = [];
  for (const printing of printings) {
    if (printing.gameKey !== rule.game_key) {
      continue;
    }
    if (rule.language_code && printing.languageCode !== rule.language_code) {
      continue;
    }
    if (rule.concept_key && printing.conceptKey !== rule.concept_key) {
      continue;
    }
    if (rule.set_key && printing.setKey !== rule.set_key) {
      continue;
    }
    if (rule.variant_key && printing.variantKey !== rule.variant_key) {
      continue;
    }
    if (rule.era === "modern" && !MODERN_SET_KEYS.has(printing.setKey)) {
      continue;
    }
    const condition = rule.condition ?? "nm";
    if (rule.raw_graded === "psa10") {
      const price = await soldPriceAsOf(db, {
        printingId: printing.id,
        asOf,
        condition,
        rawGraded: "psa10",
      });
      if (price == null) {
        continue;
      }
      qualified.push({ printingId: printing.id, sales30d: 1 });
      continue;
    }
    const sales30d = await salesCountAsOf(db, printing.id, asOf, 30, condition);
    const history = await historyCountAsOf(db, printing.id, asOf, condition);
    if (sales30d < (rule.min_sales_30d ?? definition.minLiquidity)) {
      continue;
    }
    if (history < (rule.min_history_observations ?? definition.minHistory)) {
      continue;
    }
    qualified.push({ printingId: printing.id, sales30d });
  }
  return qualified;
}

function weights(members: { printingId: string; sales30d: number }[], method: IndexWeightingMethod) {
  if (members.length === 0) {
    return new Map<string, number>();
  }
  if (method === "liquidity.v1") {
    const total = members.reduce((sum, member) => sum + Math.max(member.sales30d, 0), 0);
    if (total <= 0) {
      const equal = 1 / members.length;
      return new Map(members.map((member) => [member.printingId, equal]));
    }
    return new Map(members.map((member) => [member.printingId, member.sales30d / total]));
  }
  const equal = 1 / members.length;
  return new Map(members.map((member) => [member.printingId, equal]));
}

export async function listMembershipAsOf(db: Database, indexKey: string, asOf: Date) {
  const rows = await db
    .select()
    .from(tcgIndexMembership)
    .where(eq(tcgIndexMembership.indexKey, indexKey))
    .orderBy(asc(tcgIndexMembership.effectiveFrom));
  return rows.filter(
    (row) =>
      row.effectiveFrom.getTime() <= asOf.getTime() &&
      (row.effectiveTo == null || row.effectiveTo.getTime() > asOf.getTime()),
  );
}

export async function rebalanceIndex(db: Database, indexKey: string, asOf: Date) {
  const definition = await getIndexDefinition(db, indexKey);
  if (!definition) {
    throw new Error(`index ${indexKey} not found.`);
  }
  const qualified = await qualifyIndexMembers(db, indexKey, asOf);
  const weighting = (definition.weightingMethod as IndexWeightingMethod) ?? DEFAULT_INDEX_WEIGHTING;
  const nextWeights = weights(qualified, weighting);
  const current = await listMembershipAsOf(db, indexKey, asOf);
  const currentIds = new Set(current.map((row) => row.printingId));
  const nextIds = new Set(qualified.map((row) => row.printingId));

  for (const row of current) {
    if (!nextIds.has(row.printingId) && row.effectiveTo == null) {
      await db
        .update(tcgIndexMembership)
        .set({ effectiveTo: asOf })
        .where(eq(tcgIndexMembership.id, row.id));
    }
  }
  for (const member of qualified) {
    if (!currentIds.has(member.printingId)) {
      await db.insert(tcgIndexMembership).values({
        id: crypto.randomUUID(),
        indexKey,
        printingId: member.printingId,
        effectiveFrom: asOf,
        effectiveTo: null,
        weight: (nextWeights.get(member.printingId) ?? 0).toFixed(8),
        methodVersion: definition.methodVersion,
      });
    }
  }
  return listMembershipAsOf(db, indexKey, asOf);
}

export async function computeIndexLevel(db: Database, indexKey: string, asOf: Date) {
  const definition = await getIndexDefinition(db, indexKey);
  if (!definition) {
    throw new Error(`index ${indexKey} not found.`);
  }
  const rule = asRule(definition.membershipRule);
  const members = await listMembershipAsOf(db, indexKey, asOf);
  if (members.length === 0) {
    return {
      indexKey,
      observedAt: asOf,
      indexValue: INDEX_BASE_VALUE,
      componentCount: 0,
      pricedCount: 0,
      coverage: 0,
      dataQuality: "insufficient_data" as const,
      methodVersion: definition.methodVersion,
      weightingMethod: definition.weightingMethod,
    };
  }
  const inception = members.reduce(
    (min, row) => (row.effectiveFrom.getTime() < min.getTime() ? row.effectiveFrom : min),
    members[0]!.effectiveFrom,
  );
  const priced: { weight: number; rel: number }[] = [];
  for (const member of members) {
    const base = await soldPriceAsOf(db, {
      printingId: member.printingId,
      asOf: member.effectiveFrom.getTime() < inception.getTime() ? inception : member.effectiveFrom,
      condition: rule.condition ?? "nm",
      rawGraded: rule.raw_graded ?? "raw",
    });
    const current = await soldPriceAsOf(db, {
      printingId: member.printingId,
      asOf,
      condition: rule.condition ?? "nm",
      rawGraded: rule.raw_graded ?? "raw",
    });
    if (base == null || current == null || base <= 0) {
      continue;
    }
    priced.push({ weight: Number(member.weight), rel: current / base });
  }
  const weightSum = priced.reduce((sum, row) => sum + row.weight, 0);
  const weighted =
    priced.length === 0 || weightSum <= 0
      ? null
      : priced.reduce((sum, row) => sum + row.weight * row.rel, 0) / weightSum;
  const coverage = members.length === 0 ? 0 : priced.length / members.length;
  const indexValue = weighted == null ? INDEX_BASE_VALUE : INDEX_BASE_VALUE * weighted;
  let dataQuality: "complete" | "partial" | "insufficient_data" = "insufficient_data";
  if (priced.length === 0) {
    dataQuality = "insufficient_data";
  } else if (coverage >= 0.8) {
    dataQuality = "complete";
  } else {
    dataQuality = "partial";
  }
  return {
    indexKey,
    observedAt: asOf,
    indexValue,
    componentCount: members.length,
    pricedCount: priced.length,
    coverage,
    dataQuality,
    methodVersion: definition.methodVersion,
    weightingMethod: definition.weightingMethod,
  };
}

export async function persistIndexLevel(db: Database, computed: Awaited<ReturnType<typeof computeIndexLevel>>) {
  const [existing] = await db
    .select()
    .from(tcgIndexLevel)
    .where(
      and(
        eq(tcgIndexLevel.indexKey, computed.indexKey),
        eq(tcgIndexLevel.observedAt, computed.observedAt),
        eq(tcgIndexLevel.methodVersion, computed.methodVersion),
      ),
    )
    .limit(1);
  if (existing) {
    return existing;
  }
  const [row] = await db
    .insert(tcgIndexLevel)
    .values({
      id: crypto.randomUUID(),
      indexKey: computed.indexKey,
      observedAt: computed.observedAt,
      indexValue: computed.indexValue.toFixed(8),
      componentCount: computed.componentCount,
      pricedCount: computed.pricedCount,
      coverage: computed.coverage.toFixed(6),
      dataQuality: computed.dataQuality,
      methodVersion: computed.methodVersion,
      weightingMethod: computed.weightingMethod,
    })
    .returning();
  return row!;
}

export async function getIndexLevelAsOf(db: Database, indexKey: string, asOf: Date) {
  const rows = await db
    .select()
    .from(tcgIndexLevel)
    .where(and(eq(tcgIndexLevel.indexKey, indexKey), lte(tcgIndexLevel.observedAt, asOf)))
    .orderBy(desc(tcgIndexLevel.observedAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function listIndexLevels(db: Database, indexKey: string, to?: Date) {
  const clauses = [eq(tcgIndexLevel.indexKey, indexKey)];
  if (to) {
    clauses.push(lte(tcgIndexLevel.observedAt, to));
  }
  return db
    .select()
    .from(tcgIndexLevel)
    .where(and(...clauses))
    .orderBy(asc(tcgIndexLevel.observedAt));
}

export function indexReturn(startLevel: number, endLevel: number): number {
  if (!(startLevel > 0)) {
    return Number.NaN;
  }
  return endLevel / startLevel - 1;
}
