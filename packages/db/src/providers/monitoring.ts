import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { withPlatformContext } from "../rls.js";
import { discoveredCreator, discoveryRun, type DiscoveryProviderKey } from "../schema/discovery.js";
import { receiveSourceContentRecord } from "../source/ingest.js";
import { latestTrustState } from "../creator/authority.js";
import { getProviderRuntime } from "./runtime.js";
import { providerCredentialStatus, resolveProviderMode } from "./catalog.js";
import { budgetedDiscoveryTransport, DiscoveryBudgetError } from "./discovery-budget.js";
import { createLiveRedditProvider, createLiveYoutubeProvider } from "./live-social.js";
import { ProviderHttpError, type HttpTransport } from "./transport.js";

export type CreatorMonitoringReport = {
  status: "completed" | "failed" | "skipped";
  received: number;
  requests: number;
  creatorId?: string;
  reason?: string;
};

/** One due creator per scheduled cycle. DB claim precedes HTTP, and all provider
 * requests use the same persistent daily budgets as discovery. A crash can delay
 * one creator until next_monitor_at, but cannot cause an uncontrolled retry loop.
 */
export async function runCreatorMonitoring(db: Database, input: {
  providerKey: DiscoveryProviderKey; env?: NodeJS.ProcessEnv; transport?: HttpTransport;
}): Promise<CreatorMonitoringReport> {
  const env = input.env ?? process.env;
  const provider = input.providerKey;
  if (resolveProviderMode(provider, env) !== "live" || !providerCredentialStatus(provider, env).present) {
    return { status: "skipped", received: 0, requests: 0, reason: "not_live_or_credentialed" };
  }
  const runId = `monitor_${randomUUID()}`;
  const target = await withPlatformContext(db, async (tx) => {
    const runtime = await getProviderRuntime(tx, provider);
    if (!runtime?.enabled || runtime.paused || runtime.mode !== "live" || (runtime.retryAfterAt && runtime.retryAfterAt > new Date())) return null;
    const [candidate] = await tx.select().from(discoveredCreator)
      .where(sql`${discoveredCreator.providerKey} = ${provider} AND ${discoveredCreator.relevanceState} = 'monitored'
        AND (${discoveredCreator.nextMonitorAt} IS NULL OR ${discoveredCreator.nextMonitorAt} <= now())`)
      .orderBy(sql`${discoveredCreator.nextMonitorAt} NULLS FIRST`, discoveredCreator.id)
      .limit(1).for("update", { skipLocked: true });
    if (!candidate) return null;
    if ((await latestTrustState(tx, candidate.creatorId)) === "excluded") {
      await tx.update(discoveredCreator).set({ relevanceState: "excluded" }).where(eq(discoveredCreator.id, candidate.id));
      return null;
    }
    await tx.update(discoveredCreator).set({ lastMonitorAttemptAt: new Date(), nextMonitorAt: sql`now() + interval '1 hour'` })
      .where(eq(discoveredCreator.id, candidate.id));
    await tx.insert(discoveryRun).values({ id: runId, providerKey: provider,
      query: "Automatic creator monitoring", trigger: "schedule", status: "started",
      metadata: { activity: "monitoring", creator_id: candidate.creatorId, result_limit: 10, latest_page_only: true },
    });
    return candidate;
  });
  if (!target) return { status: "skipped", received: 0, requests: 0, reason: "no_due_creator" };
  const budget = budgetedDiscoveryTransport(db, provider, env, input.transport);
  try {
    const records = provider === "youtube"
      ? await createLiveYoutubeProvider(env, budget.transport)!.getRecentChannelContent(target.externalAccountId, 10)
      : await createLiveRedditProvider(env, budget.transport)!.getRecentAuthorPosts(target.externalAccountId, 10);
    return await withPlatformContext(db, async (tx) => {
      // Honor an exclusion/pause made while the external request was in flight.
      const runtime = await getProviderRuntime(tx, provider);
      const [current] = await tx.select().from(discoveredCreator).where(eq(discoveredCreator.id, target.id)).for("update");
      if (!runtime?.enabled || runtime.paused || current?.relevanceState !== "monitored" || (await latestTrustState(tx, target.creatorId)) === "excluded") {
        await tx.update(discoveryRun).set({ status: "skipped", completedAt: new Date(), quotaUnits: budget.requestCount(), errorClass: "operator_paused" })
          .where(eq(discoveryRun.id, runId));
        return { status: "skipped" as const, received: 0, requests: budget.requestCount(), reason: "operator_paused" };
      }
      const seen = new Set<string>();
      for (const record of records.slice(0, 10)) {
        if (seen.has(record.content.external_content_id)) continue;
        seen.add(record.content.external_content_id);
        // Separate observation identity from canonical content identity. Future
        // engagement snapshots must not rewrite the original content/call.
        await receiveSourceContentRecord(tx, { ...record,
          provider_record_id: `${record.content.external_content_id}:${runId}`,
        });
      }
      await tx.update(discoveredCreator).set({ lastMonitorSuccessAt: new Date(), monitorErrorClass: null })
        .where(eq(discoveredCreator.id, target.id));
      await tx.update(discoveryRun).set({ status: "completed", videosSeen: seen.size,
        channelsSeen: 1, contentIngested: seen.size, quotaUnits: budget.requestCount(), completedAt: new Date(),
      }).where(eq(discoveryRun.id, runId));
      return { status: "completed" as const, received: seen.size, requests: budget.requestCount(), creatorId: target.creatorId };
    });
  } catch (error) {
    const reason = error instanceof DiscoveryBudgetError ? "budget_exhausted" : error instanceof ProviderHttpError ? error.errorClass : "monitoring_failed";
    await withPlatformContext(db, async (tx) => {
      await tx.update(discoveredCreator).set({ monitorErrorClass: reason }).where(eq(discoveredCreator.id, target.id));
      await tx.update(discoveryRun).set({ status: "failed", errorClass: reason, quotaUnits: budget.requestCount(), completedAt: new Date() })
        .where(eq(discoveryRun.id, runId));
    });
    return { status: "failed", received: 0, requests: budget.requestCount(), creatorId: target.creatorId, reason };
  }
}
