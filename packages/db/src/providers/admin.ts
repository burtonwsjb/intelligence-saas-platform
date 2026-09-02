import { desc, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { withPlatformContext } from "../rls.js";
import { insertBreakGlassAudit } from "../platform/audit.js";
import { SECRET_SCAN } from "../platform/catalog.js";
import { insertTcgPrintingIdentifier } from "../tcg/catalog.js";
import { normalizeTcgMarketIngest } from "../tcg/market-ingest.js";
import { stableMarketId } from "../tcg/market-identity.js";
import {
  intelligenceQuarantine,
  providerRuntime,
  tcgMarketQuarantineReview,
} from "../schema/provider.js";
import { tcgMarketQuarantine } from "../schema/tcg-market.js";
import { isProviderKey, type ProviderKey } from "./catalog.js";
import { retryFailedPlatformJob } from "./outbox.js";
import { setProviderControl } from "./runtime.js";
import { syncProvider } from "./sync.js";
import { safePayloadSummary } from "./safe.js";

export class ProviderAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderAdminError";
  }
}

function requireReason(reason: string) {
  const trimmed = reason.trim();
  if (trimmed.length < 1 || trimmed.length > 500) {
    throw new ProviderAdminError("A reason is required.");
  }
  if (SECRET_SCAN.test(trimmed)) {
    throw new ProviderAdminError("Reasons must not contain secrets.");
  }
  return trimmed;
}

export async function setProviderEnabled(
  db: Database,
  input: { providerKey: string; actorUserId: string; enabled: boolean; reason: string },
) {
  if (!isProviderKey(input.providerKey)) {
    throw new ProviderAdminError("Unknown provider.");
  }
  const providerKey = input.providerKey;
  const reason = requireReason(input.reason);
  return withPlatformContext(db, async (scoped) => {
    const row = await setProviderControl(scoped, {
      providerKey,
      enabled: input.enabled,
      mode: input.enabled ? undefined : "disabled",
    });
    await insertBreakGlassAudit(scoped, {
      actorUserId: input.actorUserId,
      action: input.enabled ? "provider.enable" : "provider.disable",
      targetType: "provider",
      targetId: input.providerKey,
      metadata: { reason },
    });
    return row;
  });
}

export async function setProviderPaused(
  db: Database,
  input: { providerKey: string; actorUserId: string; paused: boolean; reason: string },
) {
  if (!isProviderKey(input.providerKey)) {
    throw new ProviderAdminError("Unknown provider.");
  }
  const providerKey = input.providerKey;
  requireReason(input.reason);
  return withPlatformContext(db, async (scoped) => {
    const row = await setProviderControl(scoped, { providerKey, paused: input.paused });
    await insertBreakGlassAudit(scoped, {
      actorUserId: input.actorUserId,
      action: input.paused ? "provider.pause" : "provider.resume",
      targetType: "provider",
      targetId: input.providerKey,
      metadata: { reason: input.reason.trim() },
    });
    return row;
  });
}

export async function triggerProviderSync(
  db: Database,
  input: { providerKey: string; actorUserId: string; limit?: number; confirm: boolean },
) {
  if (!isProviderKey(input.providerKey)) {
    throw new ProviderAdminError("Unknown provider.");
  }
  if (!input.confirm) {
    throw new ProviderAdminError("Confirmation is required to trigger a provider sync.");
  }
  return withPlatformContext(db, async (scoped) => {
    const result = await syncProvider(scoped, {
      providerKey: input.providerKey,
      trigger: "admin",
      limit: input.limit ?? 10,
    });
    await insertBreakGlassAudit(scoped, {
      actorUserId: input.actorUserId,
      action: "provider.sync",
      targetType: "provider",
      targetId: input.providerKey,
      metadata: { limit: input.limit ?? 10, status: result.status },
    });
    return result;
  });
}

export async function retryProviderJob(
  db: Database,
  input: { jobId: string; actorUserId: string; reason: string },
) {
  requireReason(input.reason);
  return withPlatformContext(db, async (scoped) => {
    const retried = await retryFailedPlatformJob(scoped, input.jobId);
    await insertBreakGlassAudit(scoped, {
      actorUserId: input.actorUserId,
      action: "provider.retry",
      targetType: "platform_outbox",
      targetId: input.jobId,
      metadata: { retried },
    });
    return { retried };
  });
}

export async function listAdminProviders(db: Database) {
  return db.select().from(providerRuntime);
}

export async function listMarketQuarantineForAdmin(db: Database) {
  const rows = await db.select().from(tcgMarketQuarantine).orderBy(desc(tcgMarketQuarantine.receivedAt));
  const reviews = await db.select().from(tcgMarketQuarantineReview);
  return rows.map((row) => {
    const latest = reviews.filter((review) => review.quarantineId === row.id).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return {
      ...row,
      payloadSummary: safePayloadSummary(row.payload),
      payload: undefined,
      resolutionState: latest?.action ?? "open",
    };
  });
}

export async function listIntelligenceQuarantineForAdmin(db: Database) {
  return db.select().from(intelligenceQuarantine).orderBy(desc(intelligenceQuarantine.receivedAt));
}

export async function reviewMarketQuarantine(
  db: Database,
  input: {
    quarantineId: string;
    actorUserId: string;
    action: "retry" | "resolve_identity" | "dismiss";
    reason: string;
    printingId?: string;
    sourceNamespace?: string;
    identifierType?: string;
    identifierValue?: string;
  },
) {
  const reason = requireReason(input.reason);
  return withPlatformContext(db, async (scoped) => {
    const [row] = await scoped
      .select()
      .from(tcgMarketQuarantine)
      .where(eq(tcgMarketQuarantine.id, input.quarantineId))
      .limit(1);
    if (!row) {
      throw new ProviderAdminError("Quarantine row was not found.");
    }
    if (input.action === "resolve_identity") {
      if (!input.printingId || !input.sourceNamespace || !input.identifierType || !input.identifierValue) {
        throw new ProviderAdminError("Identity resolution requires printing and identifier fields.");
      }
      await insertTcgPrintingIdentifier(scoped, {
        printingId: input.printingId,
        sourceNamespace: input.sourceNamespace,
        identifierType: input.identifierType,
        identifierValue: input.identifierValue,
      });
    }
    await scoped.insert(tcgMarketQuarantineReview).values({
      id: crypto.randomUUID(),
      quarantineId: input.quarantineId,
      action: input.action,
      reason,
      actorUserId: input.actorUserId,
      metadata: { printingId: input.printingId ?? null },
    });
    if (input.action === "retry" || input.action === "resolve_identity") {
      const ingestId = stableMarketId("min", [row.sourceKey, row.sourceRecordId]);
      await normalizeTcgMarketIngest(scoped, ingestId);
    }
    await insertBreakGlassAudit(scoped, {
      actorUserId: input.actorUserId,
      action:
        input.action === "dismiss"
          ? "quarantine.dismiss"
          : input.action === "retry"
            ? "quarantine.retry"
            : "quarantine.resolve",
      targetType: "tcg_market_quarantine",
      targetId: input.quarantineId,
      metadata: { reason },
    });
  });
}

export async function resolveIntelligenceQuarantine(
  db: Database,
  input: { id: string; actorUserId: string; state: "retried" | "resolved" | "dismissed"; reason: string },
) {
  const reason = requireReason(input.reason);
  return withPlatformContext(db, async (scoped) => {
    await scoped
      .update(intelligenceQuarantine)
      .set({
        resolutionState: input.state,
        resolutionReason: reason,
        resolvedAt: new Date(),
        resolvedByUserId: input.actorUserId,
      })
      .where(eq(intelligenceQuarantine.id, input.id));
    await insertBreakGlassAudit(scoped, {
      actorUserId: input.actorUserId,
      action:
        input.state === "dismissed"
          ? "quarantine.dismiss"
          : input.state === "retried"
            ? "quarantine.retry"
            : "quarantine.resolve",
      targetType: "intelligence_quarantine",
      targetId: input.id,
      metadata: { reason },
    });
  });
}

export type { ProviderKey };
