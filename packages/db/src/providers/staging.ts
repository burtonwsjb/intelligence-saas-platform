import { isProductionRuntime, parseIspEnv } from "@isp/shared";
import type { Database } from "../client.js";
import { tcgPrediction } from "../schema/prediction.js";
import { sql } from "drizzle-orm";
import { withPlatformContext } from "../rls.js";
import { credentialReadinessReport } from "./credentials.js";
import { applyProviderModeFromEnv, listProviderRuntime } from "./runtime.js";
import { enqueueDueProviderSyncs, syncProvider } from "./sync.js";
import { enqueuePlatformJob, listPendingPlatformOutbox, PLATFORM_JOB_VERSION, platformJobCreatedAt } from "./outbox.js";
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
  return withPlatformContext(db, async (scoped) => {
    await applyProviderModeFromEnv(scoped, env);
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
    const pending = await listPendingPlatformOutbox(scoped, 20);
    const [published] = await scoped
      .select({ n: sql<number>`count(*)::int` })
      .from(tcgPrediction)
      .where(sql`${tcgPrediction.visibility} <> 'shadow'`);
    const liveSamples: Array<{ provider: string; received: number; status: string }> = [];
    for (const row of providers) {
      if (row.mode === "live" && row.enabled && !row.paused) {
        const sample = await syncProvider(scoped, {
          providerKey: row.providerKey,
          trigger: "smoke",
          limit: 1,
          env,
        });
        liveSamples.push({ provider: row.providerKey, received: sample.received, status: sample.status });
      }
    }
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
      queue_probe_enqueued: pending.some((row) => row.id === probeId),
      live_bounded_samples: liveSamples,
      published_predictions: Number(published?.n ?? 0),
      tenant_writes: 0,
    };
  });
}

export function formatStagingSourceSmokeReport(report: Awaited<ReturnType<typeof runStagingSourceSmoke>>): string {
  return [
    "staging source smoke",
    `providers: ${report.providers.map((row) => `${row.provider}=${row.mode}/${row.health}`).join(", ")}`,
    `queue probe: ${report.queue_probe_enqueued ? "ok" : "missing"}`,
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
  return withPlatformContext(db, async (scoped) => {
    await applyProviderModeFromEnv(scoped, env);
    const { getProviderRuntime } = await import("./runtime.js");
    const runtime = await getProviderRuntime(scoped, provider);
    if (runtime?.mode !== "live") {
      throw new StagingSourceCommandError("Provider mode must be live for staging ingest.");
    }
    const result = await syncProvider(scoped, {
      providerKey: provider,
      trigger: "staging_ingest",
      limit: input.limit,
      env,
    });
    return {
      provider,
      limit: input.limit,
      status: result.status,
      received: result.received,
      quarantined: result.quarantined,
      reason: result.reason,
    };
  });
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
