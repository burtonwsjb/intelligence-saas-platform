import { TCG_LANGUAGE_CODES, TCG_VARIANT_KEYS } from "@isp/contracts";

const FILTER_KEYS = new Set([
  "game",
  "set",
  "language",
  "variant",
  "source",
  "condition",
  "grade",
  "from",
  "to",
  "cursor",
  "limit",
  "include_membership",
]);

export class CommercialFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommercialFilterError";
  }
}

export function parseCommercialQuery(query: Record<string, string | undefined>): {
  game?: string;
  set?: string;
  language?: string;
  variant?: string;
  source?: string;
  condition?: string;
  grade?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
  includeMembership: boolean;
} {
  for (const key of Object.keys(query)) {
    if (!FILTER_KEYS.has(key)) {
      throw new CommercialFilterError(`Unknown filter: ${key}`);
    }
  }
  const limit = query.limit == null ? 20 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new CommercialFilterError("limit must be an integer from 1 to 100.");
  }
  if (query.language && !(TCG_LANGUAGE_CODES as readonly string[]).includes(query.language)) {
    throw new CommercialFilterError("language must be a catalogued TCG language.");
  }
  if (query.variant && !(TCG_VARIANT_KEYS as readonly string[]).includes(query.variant)) {
    throw new CommercialFilterError("variant must be a catalogued TCG variant.");
  }
  const from = query.from ? new Date(query.from) : undefined;
  const to = query.to ? new Date(query.to) : undefined;
  if (query.from && (from == null || Number.isNaN(from.getTime()))) {
    throw new CommercialFilterError("from must be an ISO datetime.");
  }
  if (query.to && (to == null || Number.isNaN(to.getTime()))) {
    throw new CommercialFilterError("to must be an ISO datetime.");
  }
  return {
    game: query.game,
    set: query.set,
    language: query.language,
    variant: query.variant,
    source: query.source,
    condition: query.condition,
    grade: query.grade,
    from,
    to,
    cursor: query.cursor,
    limit,
    includeMembership: query.include_membership === "true",
  };
}

export function encodeCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): string | null {
  if (!cursor) {
    return null;
  }
  try {
    const value = Buffer.from(cursor, "base64url").toString("utf8");
    return value.length > 0 ? value : null;
  } catch {
    throw new CommercialFilterError("cursor is invalid.");
  }
}
