import type { Database } from "../client.js";
import { tcgPrinting, tcgSet } from "../schema/tcg.js";
import { eq } from "drizzle-orm";
import { BENCHMARK_RESOLVER_VERSION } from "./catalog.js";
import { getIndexDefinition, getIndexLevelAsOf, listIndexDefinitions } from "./index-engine.js";

export type BenchmarkRequest = {
  printingId?: string;
  gameKey: string;
  languageCode: string;
  setKey?: string | null;
  era?: string | null;
  asOf: Date;
  minCoverage?: number;
  minComponents?: number;
};

export type BenchmarkResolution = {
  status: "ok" | "insufficient_benchmark";
  indexKey: string | null;
  selection: string | null;
  version: typeof BENCHMARK_RESOLVER_VERSION;
  coverage: number | null;
  componentCount: number | null;
  level: number | null;
};

async function qualified(
  db: Database,
  indexKey: string,
  asOf: Date,
  minCoverage: number,
  minComponents: number,
) {
  const definition = await getIndexDefinition(db, indexKey);
  if (!definition || definition.status !== "active") {
    return null;
  }
  const level = await getIndexLevelAsOf(db, indexKey, asOf);
  if (!level) {
    return null;
  }
  const coverage = Number(level.coverage);
  if (level.componentCount < minComponents || coverage < minCoverage) {
    return null;
  }
  return { definition, level, coverage };
}

export async function resolveBenchmark(db: Database, input: BenchmarkRequest): Promise<BenchmarkResolution> {
  const minCoverage = input.minCoverage ?? 0.5;
  const minComponents = input.minComponents ?? 1;
  const empty: BenchmarkResolution = {
    status: "insufficient_benchmark",
    indexKey: null,
    selection: null,
    version: BENCHMARK_RESOLVER_VERSION,
    coverage: null,
    componentCount: null,
    level: null,
  };

  const candidates: { key: string; selection: string }[] = [];
  if (input.setKey) {
    candidates.push({
      key: `${input.gameKey}.set.${input.setKey}.${input.languageCode}`,
      selection: "set+language",
    });
  }
  if (input.era) {
    candidates.push({
      key: `${input.gameKey}.${input.era}.${input.languageCode}`,
      selection: "era+language+game",
    });
  }
  candidates.push({
    key: `${input.gameKey}.language.${input.languageCode}`,
    selection: "game+language",
  });

  for (const candidate of candidates) {
    const hit = await qualified(db, candidate.key, input.asOf, minCoverage, minComponents);
    if (hit) {
      return {
        status: "ok",
        indexKey: candidate.key,
        selection: candidate.selection,
        version: BENCHMARK_RESOLVER_VERSION,
        coverage: hit.coverage,
        componentCount: hit.level.componentCount,
        level: Number(hit.level.indexValue),
      };
    }
  }

  const sameLanguage = (await listIndexDefinitions(db, { gameKey: input.gameKey, languageCode: input.languageCode })).filter(
    (row) => row.languageCode === input.languageCode,
  );
  for (const row of sameLanguage) {
    const hit = await qualified(db, row.indexKey, input.asOf, minCoverage, minComponents);
    if (hit) {
      return {
        status: "ok",
        indexKey: row.indexKey,
        selection: "game+language-fallback",
        version: BENCHMARK_RESOLVER_VERSION,
        coverage: hit.coverage,
        componentCount: hit.level.componentCount,
        level: Number(hit.level.indexValue),
      };
    }
  }

  return empty;
}

export async function printingBenchmarkContext(db: Database, printingId: string) {
  const [row] = await db
    .select({
      gameKey: tcgPrinting.gameKey,
      languageCode: tcgPrinting.languageCode,
      setKey: tcgSet.canonicalSetKey,
    })
    .from(tcgPrinting)
    .innerJoin(tcgSet, eq(tcgSet.id, tcgPrinting.setId))
    .where(eq(tcgPrinting.id, printingId))
    .limit(1);
  return row ?? null;
}
