import { and, eq, sql } from "drizzle-orm";
import { assertTenantContext } from "../rls.js";
import { usageEvent, usageMonth } from "../schema/usage.js";
import type { Database } from "../client.js";

export async function recordUsage(
  scoped: Database,
  input: {
    id: string;
    organizationId: string;
    apiKeyId?: string | null;
    meterKey: string;
    quantity: number;
    idempotencyKey?: string | null;
    occurredAt?: Date;
  },
): Promise<{ inserted: boolean }> {
  await assertTenantContext(scoped);
  const inserted = await scoped
    .insert(usageEvent)
    .values({
      id: input.id,
      organizationId: input.organizationId,
      apiKeyId: input.apiKeyId,
      meterKey: input.meterKey,
      quantity: input.quantity,
      idempotencyKey: input.idempotencyKey,
      occurredAt: input.occurredAt ?? new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: usageEvent.id });
  if (inserted.length === 0) {
    return { inserted: false };
  }
  const periodStart = monthStartUtc(input.occurredAt ?? new Date());
  await scoped
    .insert(usageMonth)
    .values({
      organizationId: input.organizationId,
      meterKey: input.meterKey,
      periodStart,
      quantity: input.quantity,
    })
    .onConflictDoUpdate({
      target: [usageMonth.organizationId, usageMonth.meterKey, usageMonth.periodStart],
      set: {
        quantity: sql`${usageMonth.quantity} + ${input.quantity}`,
      },
    });
  return { inserted: true };
}

export async function getMonthUsage(
  scoped: Database,
  input: { organizationId: string; meterKey: string; at?: Date },
): Promise<number> {
  await assertTenantContext(scoped);
  const periodStart = monthStartUtc(input.at ?? new Date());
  const [row] = await scoped
    .select({ quantity: usageMonth.quantity })
    .from(usageMonth)
    .where(
      and(
        eq(usageMonth.organizationId, input.organizationId),
        eq(usageMonth.meterKey, input.meterKey),
        eq(usageMonth.periodStart, periodStart),
      ),
    )
    .limit(1);
  return row?.quantity ?? 0;
}

export function monthStartUtc(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}
