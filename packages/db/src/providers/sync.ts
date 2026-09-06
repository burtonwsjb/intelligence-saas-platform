import { runCreatorMonitoring } from "./monitoring.js";
import { isHostedRuntime } from "@isp/shared";
import { withPlatformContext } from "../rls.js";
import { createHash } from "node:crypto";
import type { Database } from "../client.js";
import { receiveTcgMarketRecord } from "../tcg/market-ingest.js";
import { tcgMarketFixtureRecords } from "../tcg/market-fixtures.js";
import {
  FixtureTcgMarketProvider,
  type TcgMarketProvider,
} from "../tcg/market-provider.js";
import type { TcgMarketRecordInput } from "../tcg/market-identity.js";
import {
  PLATFORM_JOB_VERSION,
  enqueuePlatformJob,
  platformJobCreatedAt,
} from "./outbox.js";
import {
  DEFAULT_SCHEDULE_SECONDS,
  isProviderKey,
  providerCredentialStatus,
  resolveProviderMode,
  type ProviderKey,
} from "./catalog.js";
import { decideProviderSyncDue, providerSyncBucketId } from "./schedule.js";
import { createLiveMarketProvider } from "./live-market.js";
import {
  isDiscoveryProviderKey,
  runSocialDiscovery,
} from "./discovery.js";
import {
  ensureProviderRuntimeRows,
  finishProviderSyncRun,
  getProviderRuntime,
  insertProviderSyncRun,
  recordProviderSyncResult,
  releaseProviderLease,
  tryAcquireProviderLease,
} from "./runtime.js";
import { ProviderHttpError, type HttpTransport } from "./transport.js";
import { intelligenceQuarantine } from "../schema/provider.js";
import { safePayloadSummary } from "./safe.js";

export class ProviderSyncError extends Error {
  readonly errorClass: string;
  constructor(message: string, errorClass: string) {
    super(message);
    this.name = "ProviderSyncError";
    this.errorClass = errorClass;
  }
}

function syncRunId(providerKey: string, trigger: string, at: Date) {
  return `psr_${createHash("sha256").update(`${providerKey}|${trigger}|${at.toISOString()}`).digest("hex").slice(0, 24)}`;
}

async function enqueueMarketNormalize(db: Database, ingestId: string) {
  return enqueuePlatformJob(db, {
    id: `tcg.market.normalize.v1:${ingestId}`,
    jobType: "tcg.market.normalize.v1",
    payload: {
      job_version: PLATFORM_JOB_VERSION,
      job_type: "tcg.market.normalize.v1",
      job_id: `tcg.market.normalize.v1:${ingestId}`,
      market_ingest_id: ingestId,
      created_at: platformJobCreatedAt(),
    },
  });
}

async function quarantineIntelligence(
  db: Database,
  input: { providerKey: string; recordType: string; reason: string; payload: Record<string, unknown> },
) {
  const fingerprint = createHash("sha256")
    .update(`${input.providerKey}|${input.recordType}|${input.reason}|${JSON.stringify(input.payload)}`)
    .digest("hex");
  await db
    .insert(intelligenceQuarantine)
    .values({
      id: `iqz_${fingerprint.slice(0, 32)}`,
      providerKey: input.providerKey,
      recordType: input.recordType,
      reason: input.reason,
      payloadSummary: safePayloadSummary(input.payload),
      fingerprint,
    })
    .onConflictDoNothing();
}

export function resolveMarketProvider(
  providerKey: "tcg_card_central" | "tcgplayer" | "ebay",
  mode: string,
  env: NodeJS.ProcessEnv,
  transport?: HttpTransport,
): TcgMarketProvider | null {
  if (mode === "fixture") {
    return new FixtureTcgMarketProvider(tcgMarketFixtureRecords(), providerKey);
  }
  if (mode === "live") {
    return createLiveMarketProvider(providerKey, env, transport);
  }
  return null;
}

type ProviderSyncInput = {
  providerKey: string; trigger: "schedule" | "admin" | "staging_ingest" | "smoke";
  limit?: number; env?: NodeJS.ProcessEnv; transport?: HttpTransport; query?: string;
};
export async function syncProvider(db: Database, input: ProviderSyncInput) {
  // Social discovery manages short independent transactions so HTTP failures do
  // not roll back request reservations. Market normalization keeps its existing scope.
  if (!isDiscoveryProviderKey(input.providerKey)) return withPlatformContext(db, (tx) => syncProviderInTransaction(tx, input));
  const providerKey = input.providerKey;
  const env = input.env ?? process.env;
  const mode = resolveProviderMode(providerKey, env);
  if (mode === "disabled") return { status: "skipped" as const, reason: "disabled", received: 0, quarantined: 0 };
  if (mode === "live" && !providerCredentialStatus(providerKey, env).present) {
    return { status: "skipped" as const, reason: "disabled_pending_credentials", received: 0, quarantined: 0 };
  }
  const runtime = await withPlatformContext(db, async (tx) => {
    await ensureProviderRuntimeRows(tx, env);
    return getProviderRuntime(tx, providerKey);
  });
  if (runtime?.paused || (isHostedRuntime(env) && (!runtime?.enabled || runtime.mode !== "live"))) {
    return { status: "skipped" as const, reason: "paused_or_disabled", received: 0, quarantined: 0 };
  }
  if (runtime?.retryAfterAt && runtime.retryAfterAt.getTime() > Date.now()) return { status: "skipped" as const, reason: "throttled", received: 0, quarantined: 0 };
  const leased = await withPlatformContext(db, (tx) => tryAcquireProviderLease(tx, providerKey));
  if (!leased) return { status: "skipped" as const, reason: "overlap", received: 0, quarantined: 0 };
  try {
    const monitoring = input.trigger === "schedule" ? await runCreatorMonitoring(db, { providerKey, env, transport: input.transport }) : null;
    const report = await runSocialDiscovery(db, { providerKey, query: input.query,
      trigger: input.trigger === "admin" ? "admin" : input.trigger === "schedule" ? "schedule" : "staging",
      limit: Math.min(input.limit ?? 10, 10), env, transport: input.transport });
    const received = report.content_ingested + (monitoring?.received ?? 0);
    const ok = report.status === "completed" && monitoring?.status !== "failed";
    const reason = report.reason ?? (monitoring?.status === "failed" ? monitoring.reason : null);
    await withPlatformContext(db, (tx) => recordProviderSyncResult(tx, {
      providerKey, ok, errorClass: reason,
      received, healthStatus: ok ? "healthy" : "failed",
    }));
    return { status: ok ? "completed" as const : report.status === "skipped" ? "skipped" as const : "failed" as const, reason, received, quarantined: 0 };
  } finally {
    await withPlatformContext(db, (tx) => releaseProviderLease(tx, providerKey));
  }
}

async function syncProviderInTransaction(
  db: Database,
  input: {
    providerKey: string;
    trigger: "schedule" | "admin" | "staging_ingest" | "smoke";
    limit?: number;
    env?: NodeJS.ProcessEnv;
    transport?: HttpTransport;
  },
) {
  const env = input.env ?? process.env;
  if (!isProviderKey(input.providerKey) || isDiscoveryProviderKey(input.providerKey)) {
    throw new ProviderSyncError("Unknown provider.", "invalid_provider");
  }
  await ensureProviderRuntimeRows(db, env);
  const runtime = await getProviderRuntime(db, input.providerKey);
  const mode = resolveProviderMode(input.providerKey, env);
  if (runtime?.paused) {
    return { status: "skipped" as const, reason: "paused", received: 0, quarantined: 0 };
  }
  if (mode === "disabled") {
    return { status: "skipped" as const, reason: "disabled", received: 0, quarantined: 0 };
  }
  if (mode === "live" && !providerCredentialStatus(input.providerKey, env).present) {
    await recordProviderSyncResult(db, {
      providerKey: input.providerKey,
      ok: false,
      errorClass: "disabled_pending_credentials",
      healthStatus: "disabled_pending_credentials",
    });
    return { status: "skipped" as const, reason: "disabled_pending_credentials", received: 0, quarantined: 0 };
  }
  if (runtime?.retryAfterAt && runtime.retryAfterAt.getTime() > Date.now()) {
    return { status: "skipped" as const, reason: "throttled", received: 0, quarantined: 0 };
  }
  const leased = await tryAcquireProviderLease(db, input.providerKey);
  if (!leased) {
    return { status: "skipped" as const, reason: "overlap", received: 0, quarantined: 0 };
  }

  const runId = syncRunId(input.providerKey, input.trigger, new Date());
  await insertProviderSyncRun(db, {
    id: runId,
    providerKey: input.providerKey,
    mode,
    trigger: input.trigger,
    limitCount: input.limit ?? null,
  });

  const limit = Math.min(Math.max(input.limit ?? 25, 1), 50);
  let received = 0;
  let quarantined = 0;
  let lastSourceId: string | null = runtime?.lastSourceId ?? null;
  let lastSourceTimestamp: Date | null = runtime?.lastSourceTimestamp ?? null;

  try {
    const provider = resolveMarketProvider(input.providerKey, mode, env, input.transport);
    if (!provider) {
      throw new ProviderSyncError("Live market provider is not configured.", "disabled_pending_credentials");
    }
    const after = runtime?.lastSourceId;
    const records: TcgMarketRecordInput[] = (await provider.getMarketSnapshots({}))
      .filter((row) => !after || row.provider_record_id > after)
      .slice(0, limit);
    for (const record of records) {
      try {
        const accepted = await receiveTcgMarketRecord(db, record);
        await enqueueMarketNormalize(db, accepted.ingestId);
        received += 1;
        lastSourceId = record.provider_record_id;
        lastSourceTimestamp = new Date(record.observed_at);
      } catch (error) {
        quarantined += 1;
        await quarantineIntelligence(db, {
          providerKey: input.providerKey,
          recordType: "market_observation",
          reason: error instanceof Error ? error.name : "invalid_payload",
          payload: { provider_record_id: record.provider_record_id },
        });
      }
    }

    await recordProviderSyncResult(db, {
      providerKey: input.providerKey,
      ok: true,
      received,
      quarantined,
      lastSourceId,
      lastSourceTimestamp,
      cursor: { last_source_id: lastSourceId },
      healthStatus: "healthy",
    });
    await finishProviderSyncRun(db, {
      id: runId,
      status: "completed",
      receivedCount: received,
      quarantinedCount: quarantined,
      checkpoint: { last_source_id: lastSourceId },
    });
    return { status: "completed" as const, reason: null, received, quarantined };
  } catch (error) {
    const errorClass =
      error instanceof ProviderHttpError
        ? error.errorClass
        : error instanceof ProviderSyncError
          ? error.errorClass
          : "failed";
    const retryAfterAt =
      error instanceof ProviderHttpError && error.retryAfterMs
        ? new Date(Date.now() + error.retryAfterMs)
        : null;
    await recordProviderSyncResult(db, {
      providerKey: input.providerKey,
      ok: false,
      errorClass,
      retryAfterAt,
      healthStatus: errorClass === "rate_limited" ? "throttled" : "failed",
    });
    await finishProviderSyncRun(db, { id: runId, status: "failed", errorClass });
    return { status: "failed" as const, reason: errorClass, received, quarantined };
  } finally {
    await releaseProviderLease(db, input.providerKey);
  }
}

export async function enqueueDueProviderSyncs(db: Database, env: NodeJS.ProcessEnv = process.env) {
  await ensureProviderRuntimeRows(db, env);
  const { listProviderRuntime } = await import("./runtime.js");
  const rows = await listProviderRuntime(db);
  const due: string[] = [];
  const now = new Date();
  for (const row of rows) {
    const decision = decideProviderSyncDue(row, now);
    if (!decision.due) {
      continue;
    }
    const interval = (row.scheduleSeconds || DEFAULT_SCHEDULE_SECONDS[row.providerKey as ProviderKey]) * 1000;
    const jobId = providerSyncBucketId(row.providerKey, interval, now);
    await enqueuePlatformJob(db, {
      id: jobId,
      jobType: "provider.sync.v1",
      payload: {
        job_version: PLATFORM_JOB_VERSION,
        job_type: "provider.sync.v1",
        job_id: jobId,
        provider_key: row.providerKey,
        created_at: platformJobCreatedAt(),
      },
    });
    due.push(row.providerKey);
  }
  return due;
}
