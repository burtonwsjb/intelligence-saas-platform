import { desc, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { assertTenantContext } from "../rls.js";
import { crmChurnReason } from "../schema/crm.js";
import { isChurnReasonCategory } from "./catalog.js";
import { transitionLifecycle } from "./profile.js";

export class InvalidChurnReasonError extends Error {
  constructor() {
    super("Unknown churn reason category.");
    this.name = "InvalidChurnReasonError";
  }
}

export async function captureChurnReason(
  scoped: Database,
  input: {
    organizationId: string;
    category: string;
    note?: string | null;
    capturedByUserId?: string | null;
    toStage?: "canceled" | "churned";
  },
) {
  await assertTenantContext(scoped);
  if (!isChurnReasonCategory(input.category)) {
    throw new InvalidChurnReasonError();
  }
  const [row] = await scoped
    .insert(crmChurnReason)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      category: input.category,
      note: input.note?.slice(0, 500) ?? null,
      capturedByUserId: input.capturedByUserId ?? null,
    })
    .returning();
  await transitionLifecycle(scoped, {
    organizationId: input.organizationId,
    toStage: input.toStage ?? "canceled",
    reason: `churn.${input.category}`,
    actorType: "user",
  });
  return row!;
}

export async function listChurnReasons(scoped: Database, organizationId: string) {
  await assertTenantContext(scoped);
  return scoped
    .select()
    .from(crmChurnReason)
    .where(eq(crmChurnReason.organizationId, organizationId))
    .orderBy(desc(crmChurnReason.capturedAt));
}
