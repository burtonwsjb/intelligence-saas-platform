/**
 * The customer site (tcgsentiment.com) lives on the bare domain. The www form
 * sends visitors there with a permanent redirect, keeping path and query.
 * socialsignaliq.com is the data engine (API + worker) on Railway, not this site.
 */
export const CANONICAL_HOST = "tcgsentiment.com";
export const CANONICAL_ORIGIN = `https://${CANONICAL_HOST}`;

/** Hosts that must never serve pages themselves; each one 308s to CANONICAL_HOST. */
export const REDIRECT_HOSTS: ReadonlySet<string> = new Set([
  "www.tcgsentiment.com",
]);

/** Lowercased host without port or trailing dot, or null when missing. */
export function normalizeHost(value: string | null | undefined): string | null {
  const first = value?.split(",")[0]?.trim().toLowerCase();
  if (!first) {
    return null;
  }
  return first.replace(/:\d+$/, "").replace(/\.$/, "") || null;
}

/**
 * The canonical URL to redirect to when `host` is the www host,
 * otherwise null (staging, Railway domains, localhost and the apex pass through).
 */
export function canonicalRedirectUrl(host: string | null | undefined, pathname: string, search: string): string | null {
  const normalized = normalizeHost(host);
  if (!normalized || !REDIRECT_HOSTS.has(normalized)) {
    return null;
  }
  const path = pathname.startsWith("/") && !pathname.startsWith("//") ? pathname : "/";
  return `${CANONICAL_ORIGIN}${path}${search}`;
}
