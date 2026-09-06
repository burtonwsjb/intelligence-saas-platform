import { createHash } from "node:crypto";

export type CatalogRow = Record<string, unknown>;
export const CATALOG_KEYS = {
  relations: ["schema", "name"],
  columns: ["schema", "name", "column_name"],
  constraints: ["schema", "name", "constraint_name"],
  indexes: ["schema", "name", "index_name"],
  policies: ["schema", "name", "policyname"],
  triggers: ["schema", "name", "trigger_name"],
  functions: ["schema", "name", "args"],
} as const;
export type CatalogGroup = keyof typeof CATALOG_KEYS;
export type CatalogSnapshot = Record<CatalogGroup, CatalogRow[]>;
export type DriftExample = {
  change: "missing" | "unexpected" | "changed";
  object: string;
  fields?: string[];
};
export type CatalogDifference = {
  catalog: CatalogGroup;
  missing: number;
  unexpected: number;
  changed: number;
  examples: DriftExample[];
  examplesTruncated: boolean;
};
export type CandidateDrift = {
  migration: string;
  differenceCount: number;
  groups: CatalogDifference[];
};
export type BaselineDiagnostics = {
  comparisonVersion: "catalog.v2";
  exactMatch: false;
  nearestCandidates: Array<{ migration: string; differenceCount: number }>;
  // Nearest is only a diagnostic comparison, never permission to adopt it.
  comparisonAgainst: string;
  groups: CatalogDifference[];
};
function stable(row: CatalogRow): string {
  return JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))));
}
function key(row: CatalogRow, fields: readonly string[]): string {
  return JSON.stringify(fields.map((field) => row[field]));
}
function opaque(value: string): string {
  return `[unrecognized:${createHash("sha256").update(value).digest("hex").slice(0, 12)}]`;
}
/** Only repository-derived identifiers may be printed. Never print target SQL,
 * defaults, function bodies, policy expressions, URLs, or arbitrary identifiers. */
function objectLabel(row: CatalogRow, fields: readonly string[], trusted?: CatalogRow): string {
  if (!trusted) return opaque(key(row, fields));
  return fields.map((field) => {
    const value = String(trusted[field] ?? "");
    // Function signatures need not be printed to distinguish overloads.
    if (field === "args") return opaque(value);
    return /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(value) ? value : opaque(value);
  }).join(".");
}
function groupRows(rows: CatalogRow[], fields: readonly string[]): Map<string, CatalogRow[]> {
  const result = new Map<string, CatalogRow[]>();
  for (const row of rows) {
    const id = key(row, fields);
    result.set(id, [...(result.get(id) ?? []), row]);
  }
  return result;
}
export function compareCatalogs(expected: CatalogSnapshot, actual: CatalogSnapshot, migration: string): CandidateDrift {
  const groups: CatalogDifference[] = [];
  for (const catalog of Object.keys(CATALOG_KEYS) as CatalogGroup[]) {
    const fields = CATALOG_KEYS[catalog];
    const before = groupRows(expected[catalog], fields);
    const after = groupRows(actual[catalog], fields);
    const differences: DriftExample[] = [];
    let missing = 0, unexpected = 0, changed = 0;
    for (const [id, rows] of before) {
      const row = rows[0]!;
      const observed = after.get(id);
      if (!observed) {
        missing += rows.length;
        differences.push({ change: "missing", object: objectLabel(row, fields, row) });
      } else if (JSON.stringify(rows.map(stable).sort()) !== JSON.stringify(observed.map(stable).sort())) {
        changed += 1;
        differences.push({
          change: "changed", object: objectLabel(row, fields, row),
          fields: rows.length === 1 && observed.length === 1
            ? Object.keys(row).filter((field) => stable({ value: row[field] }) !== stable({ value: observed[0]![field] })).sort()
            : ["row_count_or_definition"],
        });
      }
    }
    for (const [id, rows] of after) {
      if (!before.has(id)) {
        const row = rows[0]!;
        unexpected += rows.length;
        // Preserve a trusted table/function name where possible, but never an
        // unknown column/constraint name that might contain a credential.
        const parent = expected[catalog].find((item) => item.schema === row.schema && item.name === row.name);
        const label = parent ? `${objectLabel(parent, ["schema", "name"], parent)}.${opaque(id)}` : opaque(id);
        differences.push({ change: "unexpected", object: label });
      }
    }
    if (differences.length) groups.push({ catalog, missing, unexpected, changed, examples: differences.slice(0, 5), examplesTruncated: differences.length > 5 });
  }
  return { migration, differenceCount: groups.reduce((sum, group) => sum + group.missing + group.unexpected + group.changed, 0), groups };
}
export function baselineDiagnostics(candidates: CandidateDrift[]): BaselineDiagnostics {
  if (!candidates.length) throw new Error("No diagnostic candidates");
  const nearest = [...candidates].sort((a, b) => a.differenceCount - b.differenceCount || b.migration.localeCompare(a.migration)).slice(0, 3);
  return {
    comparisonVersion: "catalog.v2", exactMatch: false,
    nearestCandidates: nearest.map(({ migration, differenceCount }) => ({ migration, differenceCount })),
    comparisonAgainst: nearest[0]!.migration, groups: nearest[0]!.groups,
  };
}
