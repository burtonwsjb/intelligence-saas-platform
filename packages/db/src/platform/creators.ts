import type { Database } from "../client.js";
import { withPlatformContext } from "../rls.js";
import { listCallsByCreator } from "../creator/query.js";
import { latestTrustState, recordCreatorTrust, recomputeCreatorAuthority } from "../creator/authority.js";
import { SECRET_SCAN, isOperatorTrustState } from "./catalog.js";
import { insertBreakGlassAudit } from "./audit.js";

export class CreatorModerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreatorModerationError";
  }
}

/**
 * Records an append-only trust event. Call history is never deleted.
 * Must run as `app_admin` with `withPlatformContext` (system principal).
 */
export async function setCreatorTrustKeepingHistory(
  db: Database,
  input: {
    creatorId: string;
    actorUserId: string;
    trustState: string;
    reason: string;
  },
) {
  if (!isOperatorTrustState(input.trustState)) {
    throw new CreatorModerationError("Unknown creator trust state.");
  }
  const reason = input.reason.trim();
  if (reason.length < 1 || reason.length > 500) {
    throw new CreatorModerationError("Trust reason is required.");
  }
  if (SECRET_SCAN.test(reason)) {
    throw new CreatorModerationError("Trust reasons must not contain secrets.");
  }
  return withPlatformContext(db, async (scoped) => {
    const before = await listCallsByCreator(scoped, input.creatorId);
    await recordCreatorTrust(scoped, {
      creatorId: input.creatorId,
      trustState: input.trustState,
      reason,
    });
    await recomputeCreatorAuthority(scoped, input.creatorId);
    const after = await listCallsByCreator(scoped, input.creatorId);
    if (after.length < before.length) {
      throw new CreatorModerationError("Creator exclusion must not delete call history.");
    }
    await insertBreakGlassAudit(scoped, {
      actorUserId: input.actorUserId,
      action: input.trustState === "excluded" ? "creator.exclude" : "creator.trust",
      targetType: "creator",
      targetId: input.creatorId,
      metadata: { trustState: input.trustState, callCount: after.length },
    });
    return {
      creatorId: input.creatorId,
      trustState: (await latestTrustState(scoped, input.creatorId)) ?? input.trustState,
      callCount: after.length,
    };
  });
}

export async function excludeCreatorKeepingHistory(
  db: Database,
  input: { creatorId: string; actorUserId: string; reason: string },
) {
  return setCreatorTrustKeepingHistory(db, { ...input, trustState: "excluded" });
}
