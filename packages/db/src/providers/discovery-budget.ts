import { sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { withPlatformContext } from "../rls.js";
import { ProviderHttpError, createFetchTransport, type HttpTransport } from "./transport.js";
import type { DiscoveryProviderKey } from "../schema/discovery.js";

export class DiscoveryBudgetError extends Error {
  constructor() { super("Discovery daily request budget exhausted."); this.name = "DiscoveryBudgetError"; }
}
export function discoveryRequestBudget(env: NodeJS.ProcessEnv, provider: DiscoveryProviderKey, bucket: "search" | "data"): number {
  const key = `${provider.toUpperCase()}_DISCOVERY_${bucket.toUpperCase()}_REQUESTS_PER_DAY`;
  const value = env[key];
  const fallback = bucket === "search" ? 20 : 200;
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 10_000) throw new Error("Invalid discovery request budget configuration.");
  return parsed;
}
export async function reserveDiscoveryRequest(db: Database, provider: DiscoveryProviderKey, bucket: "search" | "data", budget: number): Promise<void> {
  if (budget < 1) throw new DiscoveryBudgetError();
  // A short independent transaction is committed BEFORE the HTTP request. Failed
  // HTTP requests still consume budget. Do not wrap the whole discovery run in a transaction.
  const allowed = await withPlatformContext(db, async (tx) => {
    const result = await tx.execute(sql`
      INSERT INTO discovery_request_budget (provider_key,bucket,budget_day,requests_used)
      VALUES (${provider},${bucket},(now() AT TIME ZONE 'America/Los_Angeles')::date,1)
      ON CONFLICT (provider_key,bucket,budget_day) DO UPDATE
        SET requests_used=discovery_request_budget.requests_used+1, updated_at=now()
        WHERE discovery_request_budget.requests_used < ${budget}
      RETURNING requests_used`);
    const rows = Array.isArray(result) ? result : (result as unknown as { rows: unknown[] }).rows;
    return rows.length > 0;
  });
  if (!allowed) throw new DiscoveryBudgetError();
}
export function budgetedDiscoveryTransport(db: Database, provider: DiscoveryProviderKey, env: NodeJS.ProcessEnv, transport: HttpTransport = createFetchTransport()) {
  let requests = 0;
  return {
    requestCount: () => requests,
    transport: {
      async fetch(url, init) {
        // Inspect only an allowlisted provider path. No URL or credential enters logs.
        let parsed: URL;
        try { parsed = new URL(url); } catch { throw new ProviderHttpError({ status: 0, errorClass: "invalid_endpoint" }); }
        const allowed = provider === "youtube" ? parsed.hostname === "www.googleapis.com" : ["www.reddit.com","oauth.reddit.com"].includes(parsed.hostname);
        if (!allowed || parsed.protocol !== "https:") throw new ProviderHttpError({ status: 0, errorClass: "invalid_endpoint" });
        const bucket = /\/search$/.test(parsed.pathname) ? "search" : "data";
        await reserveDiscoveryRequest(db, provider, bucket, discoveryRequestBudget(env, provider, bucket));
        requests += 1;
        return transport.fetch(url, init);
      },
    } satisfies HttpTransport,
  };
}
