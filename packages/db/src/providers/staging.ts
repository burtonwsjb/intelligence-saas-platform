import { isProductionRuntime, parseIspEnv } from "@isp/shared";
import type { Database } from "../client.js";
import { tcgPrediction } from "../schema/prediction.js";
import { sql } from "drizzle-orm";
import { withPlatformContext } from "../rls.js";
import { credentialReadinessReport } from "./credentials.js";
import { ensureProviderRuntimeRows, listProviderRuntime } from "./runtime.js";
import { enqueueDueProviderSyncs, syncProvider } from "./sync.js";
import { enqueuePlatformJob, getPlatformOutbox, PLATFORM_JOB_VERSION, platformJobCreatedAt } from "./outbox.js";
import { isProviderKey } from "./catalog.js";

export class StagingSourceCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StagingSourceCommandError";
  }
}

export function assertStagingSourceCommandAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (isProductionRuntime(env)) {
    throw new StagingSourceCommandError("Refusing to run staging source commands in production.");
  }
  if (parseIspEnv(env) !== "staging") {
    throw new StagingSourceCommandError("ISP_ENV=staging is required.");
  }
}

export async function runStagingSourceSmoke(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
) {
  assertStagingSourceCommandAllowed(env);
  // Probe writes are deliberately rolled back. Smoke must never change provider
  // controls or dispatch real ingest just because a developer has a credential.
  const rollback = new Error("staging_smoke_rollback");
  let report: Awaited<ReturnType<typeof collect>> | undefined;
  async function collect(scoped: Database) {
    await ensureProviderRuntimeRows(scoped, env);
    const providers = await listProviderRuntime(scoped);
    const probeId = `smoke.queue.${Date.now()}`;
    await enqueuePlatformJob(scoped, {
      id: probeId,
      jobType: "provider.sync.v1",
      payload: {
        job_version: PLATFORM_JOB_VERSION,
        job_type: "provider.sync.v1",
        job_id: probeId,
        provider_key: "reddit",
        created_at: platformJobCreatedAt(),
      },
    });
    const probe = await getPlatformOutbox(scoped, probeId);
    const [published] = await scoped
      .select({ n: sql<number>`count(*)::int` })
      .from(tcgPrediction)
      .where(sql`${tcgPrediction.visibility} <> 'shadow'`);
    const liveSamples: Array<{ provider: string; received: number; status: string }> = [];
    return {
      environment: "staging",
      production_refused: false,
      providers: providers.map((row) => ({
        provider: row.providerKey,
        type: row.providerType,
        mode: row.mode,
        enabled: row.enabled,
        paused: row.paused,
        credential_status: row.credentialStatus,
        health: row.healthStatus,
        last_success_at: row.lastSuccessAt?.toISOString() ?? null,
        last_attempt_at: row.lastAttemptAt?.toISOString() ?? null,
        last_error_class: row.lastErrorClass,
        rate_limit_remaining: row.rateLimitRemaining,
        checkpoint: row.lastSourceId ?? null,
      })),
      credentials: credentialReadinessReport(env).map((row) => ({
        provider: row.provider,
        variable: row.environment_variable,
        configured: row.configured,
        required: row.required,
      })),
      queue_probe_enqueued: false,
      queue_probe_verified: probe?.id === probeId,
      probe_rolled_back: true,
      live_bounded_samples: liveSamples,
      published_predictions: Number(published?.n ?? 0),
      tenant_writes: 0,
    };
  }
  try {
    await withPlatformContext(db, async (tx) => {
      report = await collect(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  if (!report) throw new StagingSourceCommandError("Source smoke did not complete.");
  return report;
}

export function formatStagingSourceSmokeReport(report: Awaited<ReturnType<typeof runStagingSourceSmoke>>): string {
  return [
    "staging source smoke",
    `providers: ${report.providers.map((row) => `${row.provider}=${row.mode}/${row.health}`).join(", ")}`,
    `queue outbox probe (rolled back): ${report.queue_probe_verified ? "ok" : "missing"}`,
    `published predictions: ${report.published_predictions}`,
    `tenant writes: ${report.tenant_writes}`,
    `live samples: ${report.live_bounded_samples.length}`,
  ].join("\n");
}

export async function runStagingIngest(
  db: Database,
  input: { provider: string; limit: number; env?: NodeJS.ProcessEnv },
) {
  const env = input.env ?? process.env;
  assertStagingSourceCommandAllowed(env);
  if (!isProviderKey(input.provider)) {
    throw new StagingSourceCommandError("An explicit known --provider is required.");
  }
  const provider = input.provider;
  if (!Number.isFinite(input.limit) || input.limit < 1 || input.limit > 50) {
    throw new StagingSourceCommandError("--limit must be a small bound (1-50).");
  }
  const runtime = await withPlatformContext(db, async (scoped) => {
    const { getProviderRuntime } = await import("./runtime.js");
    return getProviderRuntime(scoped, provider);
  });
  if (runtime?.mode !== "live" || !runtime.enabled || runtime.paused) {
    throw new StagingSourceCommandError("Provider must already be live, enabled, and unpaused for staging ingest.");
  }
  const result = await syncProvider(db, { providerKey: provider, trigger: "staging_ingest", limit: input.limit, env });
  return { provider, limit: input.limit, status: result.status, received: result.received,
    quarantined: result.quarantined, reason: result.reason };
}

export function parseStagingIngestArgs(argv: string[]) {
  const providerIndex = argv.findIndex((value) => value === "--provider");
  const limitIndex = argv.findIndex((value) => value === "--limit");
  return {
    provider: providerIndex >= 0 ? argv[providerIndex + 1] ?? "" : "",
    limit: limitIndex >= 0 ? Number(argv[limitIndex + 1]) : Number.NaN,
  };
}

export { enqueueDueProviderSyncs };
