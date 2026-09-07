import { readQueueFailureSnapshot, type QueueFailureSnapshot } from "@isp/shared";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { providerRuntime, providerSyncRun, workerHeartbeat } from "../schema/provider.js";
import {
  DEFAULT_SCHEDULE_SECONDS,
  PROVIDER_KEYS,
  PROVIDER_TYPE_BY_KEY,
  providerCredentialStatus,
  resolveProviderMode,
  type ProviderKey,
} from "./catalog.js";

export async function ensureProviderRuntimeRows(db: Database, env: NodeJS.ProcessEnv = process.env) {
  for (const key of PROVIDER_KEYS) {
    const creds = providerCredentialStatus(key, env);
    const mode = resolveProviderMode(key, env);
    await db
      .insert(providerRuntime)
      .values({
        providerKey: key,
        providerType: PROVIDER_TYPE_BY_KEY[key],
        mode,
        enabled: mode !== "disabled",
        credentialStatus: mode === "live" && !creds.present ? creds.status : creds.present ? "present" : "missing",
        scheduleSeconds: DEFAULT_SCHEDULE_SECONDS[key],
      })
      .onConflictDoNothing();
  }
}

export async function listProviderRuntime(db: Database) {
  return db.select().from(providerRuntime);
}

export async function getProviderRuntime(db: Database, providerKey: ProviderKey) {
  const [row] = await db.select().from(providerRuntime).where(eq(providerRuntime.providerKey, providerKey)).limit(1);
  return row ?? null;
}

export async function applyProviderModeFromEnv(db: Database, env: NodeJS.ProcessEnv = process.env) {
  await ensureProviderRuntimeRows(db, env);
  for (const key of PROVIDER_KEYS) {
    const creds = providerCredentialStatus(key, env);
    const mode = resolveProviderMode(key, env);
    const liveBlocked = mode === "live" && !creds.present;
    await db
      .update(providerRuntime)
      .set({
        mode,
        enabled: mode !== "disabled" && !liveBlocked,
        credentialStatus: liveBlocked ? "disabled_pending_credentials" : creds.present ? "present" : "missing",
        healthStatus: liveBlocked ? "disabled_pending_credentials" : mode === "disabled" ? "unknown" : "unknown",
        updatedAt: new Date(),
      })
      .where(eq(providerRuntime.providerKey, key));
  }
}

export async function setProviderControl(
  db: Database,
  input: { providerKey: ProviderKey; enabled?: boolean; paused?: boolean; mode?: "disabled" | "fixture" | "live" },
) {
  const current = await getProviderRuntime(db, input.providerKey);
  const nextMode = input.mode ?? current?.mode ?? "disabled";
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.paused != null) {
    patch.paused = input.paused;
  }
  if (input.mode) {
    patch.mode = input.mode;
  }
  // mode=disabled + enabled=true is invalid. Disabled always wins.
  if (nextMode === "disabled") {
    patch.enabled = false;
  } else if (input.enabled != null) {
    patch.enabled = input.enabled;
  }
  await db.update(providerRuntime).set(patch).where(eq(providerRuntime.providerKey, input.providerKey));
  return getProviderRuntime(db, input.providerKey);
}

export async function tryAcquireProviderLease(
  db: Database,
  providerKey: ProviderKey,
  leaseMs = 120_000,
): Promise<boolean> {
  const seconds = Math.max(1, Math.ceil(leaseMs / 1000));
  const updated = await db
    .update(providerRuntime)
    .set({
      leaseUntil: sql`now() + (${seconds} * interval '1 second')`,
      lastAttemptAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      sql`${providerRuntime.providerKey} = ${providerKey}
        AND (${providerRuntime.leaseUntil} IS NULL OR ${providerRuntime.leaseUntil} < now())`,
    )
    .returning({ providerKey: providerRuntime.providerKey });
  return updated.length > 0;
}

export async function releaseProviderLease(db: Database, providerKey: ProviderKey) {
  await db
    .update(providerRuntime)
    .set({ leaseUntil: null, updatedAt: new Date() })
    .where(eq(providerRuntime.providerKey, providerKey));
}

export async function recordProviderSyncResult(
  db: Database,
  input: {
    providerKey: ProviderKey;
    ok: boolean;
    errorClass?: string | null;
    received?: number;
    quarantined?: number;
    cursor?: Record<string, unknown>;
    lastSourceTimestamp?: Date | null;
    lastSourceId?: string | null;
    rateLimitRemaining?: number | null;
    rateLimitResetAt?: Date | null;
    retryAfterAt?: Date | null;
    healthStatus?: string;
  },
) {
  const now = new Date();
  const patch: Record<string, unknown> = {
    lastErrorClass: input.ok ? null : (input.errorClass ?? "failed"),
    recordsIngested: sql`${providerRuntime.recordsIngested} + ${input.received ?? 0}`,
    recordsQuarantined: sql`${providerRuntime.recordsQuarantined} + ${input.quarantined ?? 0}`,
    healthStatus: input.healthStatus ?? (input.ok ? "healthy" : "failed"),
    updatedAt: now,
  };
  if (input.ok) {
    patch.lastSuccessAt = now;
  } else {
    patch.lastFailureAt = now;
  }
  if (input.cursor) {
    patch.cursor = input.cursor;
  }
  if (input.lastSourceTimestamp) {
    patch.lastSourceTimestamp = input.lastSourceTimestamp;
  }
  if (input.lastSourceId) {
    patch.lastSourceId = input.lastSourceId;
  }
  if (input.rateLimitRemaining != null) {
    patch.rateLimitRemaining = input.rateLimitRemaining;
  }
  if (input.rateLimitResetAt) {
    patch.rateLimitResetAt = input.rateLimitResetAt;
  }
  if (input.retryAfterAt) {
    patch.retryAfterAt = input.retryAfterAt;
  }
  await db.update(providerRuntime).set(patch).where(eq(providerRuntime.providerKey, input.providerKey));
}

export async function insertProviderSyncRun(
  db: Database,
  input: {
    id: string;
    providerKey: ProviderKey;
    mode: string;
    trigger: string;
    limitCount?: number | null;
  },
) {
  await db.insert(providerSyncRun).values({
    id: input.id,
    providerKey: input.providerKey,
    mode: input.mode,
    trigger: input.trigger,
    limitCount: input.limitCount ?? null,
  });
}

export async function finishProviderSyncRun(
  db: Database,
  input: {
    id: string;
    status: "completed" | "failed" | "skipped";
    receivedCount?: number;
    quarantinedCount?: number;
    errorClass?: string | null;
    checkpoint?: Record<string, unknown>;
  },
) {
  await db
    .update(providerSyncRun)
    .set({
      status: input.status,
      receivedCount: input.receivedCount ?? 0,
      quarantinedCount: input.quarantinedCount ?? 0,
      errorClass: input.errorClass ?? null,
      checkpoint: input.checkpoint ?? {},
      completedAt: new Date(),
    })
    .where(eq(providerSyncRun.id, input.id));
}

export async function upsertWorkerHeartbeat(
  db: Database,
  input: {
    workerKey?: string;
    queueDepth?: number | null;
    failedJobs?: number | null;
    queueMetricsErrorClass?: string | null;
    queueFailureSnapshot?: QueueFailureSnapshot | null;
  },
) {
  const workerKey = input.workerKey ?? "ingest";
  const now = new Date();
  const metadata = {
    role: "ingest",
    queue_metrics_error_class: input.queueMetricsErrorClass ?? null,
    queue_failure_sample: readQueueFailureSnapshot(input.queueFailureSnapshot),
  };
  await db
    .insert(workerHeartbeat)
    .values({
      workerKey,
      lastSeenAt: now,
      queueDepth: input.queueDepth ?? null,
      failedJobs: input.failedJobs ?? null,
      metadata,
    })
    .onConflictDoUpdate({
      target: workerHeartbeat.workerKey,
      set: {
        lastSeenAt: now,
        queueDepth: input.queueDepth ?? null,
        failedJobs: input.failedJobs ?? null,
        metadata,
        updatedAt: now,
      },
    });
}

export async function getWorkerHeartbeat(db: Database, workerKey = "ingest") {
  const [row] = await db.select().from(workerHeartbeat).where(eq(workerHeartbeat.workerKey, workerKey)).limit(1);
  return row ?? null;
}
