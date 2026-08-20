import { and, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { assertTenantContext } from "../rls.js";
import { getMonthUsage, monthStartUtc } from "../repos/usage.js";
import { usageWarning } from "../schema/notification.js";
import { USAGE_WARNING_THRESHOLDS } from "./catalog.js";
import { createInAppNotification } from "./inbox.js";

export async function evaluateUsageWarnings(
  scoped: Database,
  input: {
    organizationId: string;
    userId?: string | null;
    meterKey: string;
    limit: number;
    at?: Date;
  },
) {
  await assertTenantContext(scoped);
  if (!Number.isFinite(input.limit) || input.limit <= 0) {
    return [];
  }
  const at = input.at ?? new Date();
  const current = await getMonthUsage(scoped, {
    organizationId: input.organizationId,
    meterKey: input.meterKey,
    at,
  });
  const ratio = current / input.limit;
  const periodStart = monthStartUtc(at);
  const created: number[] = [];
  for (const threshold of USAGE_WARNING_THRESHOLDS) {
    if (ratio * 100 < threshold) {
      continue;
    }
    const inserted = await scoped
      .insert(usageWarning)
      .values({
        organizationId: input.organizationId,
        meterKey: input.meterKey,
        periodStart,
        thresholdPct: threshold,
      })
      .onConflictDoNothing()
      .returning({ thresholdPct: usageWarning.thresholdPct });
    if (inserted.length === 0) {
      continue;
    }
    const notification = await createInAppNotification(scoped, {
      organizationId: input.organizationId,
      userId: input.userId ?? null,
      type: "usage.warning",
      title: `Usage reached ${threshold}%`,
      body: `${input.meterKey} is at ${Math.min(100, Math.round(ratio * 100))}% of the plan limit for this period.`,
      severity: threshold >= 100 ? "critical" : threshold >= 90 ? "warning" : "info",
      referenceType: "usage_meter",
      referenceId: input.meterKey,
    });
    await scoped
      .update(usageWarning)
      .set({ notificationId: notification.id })
      .where(
        and(
          eq(usageWarning.organizationId, input.organizationId),
          eq(usageWarning.meterKey, input.meterKey),
          eq(usageWarning.periodStart, periodStart),
          eq(usageWarning.thresholdPct, threshold),
        ),
      );
    created.push(threshold);
  }
  return created;
}
