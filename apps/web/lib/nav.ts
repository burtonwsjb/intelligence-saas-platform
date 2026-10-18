import type { AppNavItem } from "@isp/db";

// Kept in the web app (not @isp/db) so the client navigation can use it
// without bundling the database package.
const ROUTE_ALIASES: Record<string, string> = {
  "/app/opportunities": "/app/cards",
  "/app/indices": "/app/markets",
};

/** Longest-prefix match so /app/cards/123 highlights Cards and /app does not swallow every route. */
export function activeNavKey(items: Pick<AppNavItem, "href" | "key">[], pathname: string): string | null {
  let path = pathname.replace(/\/+$/, "") || "/";
  for (const [from, to] of Object.entries(ROUTE_ALIASES)) {
    if (path === from || path.startsWith(`${from}/`)) {
      path = to + path.slice(from.length);
    }
  }
  let best: Pick<AppNavItem, "href" | "key"> | null = null;
  for (const item of items) {
    const matches = item.href === "/app" ? path === "/app" : path === item.href || path.startsWith(`${item.href}/`);
    if (matches && (!best || item.href.length > best.href.length)) {
      best = item;
    }
  }
  return best?.key ?? null;
}
