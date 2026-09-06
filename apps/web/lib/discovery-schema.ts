/** A pending discovery migration should show an operator-facing state, not a
 * generic page failure. Other database/authentication failures must still fail.
 * Inspect codes only; never render database messages, queries, or credentials.
 */
export function isDiscoverySchemaUnavailable(error: unknown): boolean {
  let current = error;
  const seen = new Set<object>();
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== "object" || seen.has(current)) return false;
    seen.add(current);
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === "42P01" || candidate.code === "42703") return true;
    current = candidate.cause;
  }
  return false;
}
