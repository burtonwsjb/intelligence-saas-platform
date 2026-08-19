import { and, eq } from "drizzle-orm";
import {
  insertAuditEvent,
  member,
  tenant,
  withOrganizationContext,
  type Database,
} from "@isp/db";
import { OrganizationAccessError } from "./session.js";

const ORGANIZATION_ID_PATTERN = /^[A-Za-z0-9_:-]{1,128}$/;

export const organizationIdInput = {
  safeParse(
    value: unknown,
  ): { success: true; data: string } | { success: false } {
    if (typeof value !== "string") {
      return { success: false };
    }
    const trimmed = value.trim();
    if (!ORGANIZATION_ID_PATTERN.test(trimmed)) {
      return { success: false };
    }
    return { success: true, data: trimmed };
  },
};

export class TenantInactiveError extends Error {
  constructor() {
    super("This workspace is not available.");
    this.name = "TenantInactiveError";
  }
}

export class TenantNotFoundError extends Error {
  constructor() {
    super("This workspace is not available.");
    this.name = "TenantNotFoundError";
  }
}

export type TenantStatus = "active" | "suspended" | "deleted";

export function assertTenantActive(
  status: string | null | undefined,
): asserts status is "active" {
  if (status === "suspended" || status === "deleted" || status !== "active") {
    throw new TenantInactiveError();
  }
}

export async function loadTenantStatus(
  db: Database,
  organizationId: string,
  userId: string,
): Promise<string | null> {
  const parsed = organizationIdInput.safeParse(organizationId);
  if (!parsed.success) {
    throw new TenantNotFoundError();
  }
  return withOrganizationContext(
    db,
    { organizationId: parsed.data, userId },
    async (scoped) => {
      const [row] = await scoped
        .select({ status: tenant.status })
        .from(tenant)
        .where(eq(tenant.organizationId, parsed.data))
        .limit(1);
      return row?.status ?? null;
    },
  );
}

export async function authorizeOrganizationSwitch(
  db: Database,
  input: { userId: string; requestedOrganizationId: unknown },
): Promise<{ organizationId: string; status: TenantStatus }> {
  const parsed = organizationIdInput.safeParse(input.requestedOrganizationId);
  if (!parsed.success) {
    throw new OrganizationAccessError();
  }

  const [membership] = await db
    .select({
      organizationId: member.organizationId,
      role: member.role,
    })
    .from(member)
    .where(
      and(eq(member.organizationId, parsed.data), eq(member.userId, input.userId)),
    )
    .limit(1);

  if (!membership) {
    throw new OrganizationAccessError();
  }

  const status = await loadTenantStatus(db, parsed.data, input.userId);
  if (!status) {
    throw new TenantNotFoundError();
  }
  assertTenantActive(status);
  return { organizationId: parsed.data, status };
}

export async function recordOrganizationSwitch(
  db: Database,
  input: { userId: string; organizationId: string },
): Promise<void> {
  await withOrganizationContext(
    db,
    { organizationId: input.organizationId, userId: input.userId },
    async (scoped) => {
      await insertAuditEvent(scoped, {
        id: crypto.randomUUID(),
        organizationId: input.organizationId,
        actorUserId: input.userId,
        action: "organization.switch",
        targetType: "organization",
        targetId: input.organizationId,
      });
    },
  );
}

export async function requireUsableTenant(
  db: Database,
  organizationId: string,
  userId: string,
): Promise<void> {
  const status = await loadTenantStatus(db, organizationId, userId);
  if (!status) {
    throw new TenantNotFoundError();
  }
  assertTenantActive(status);
}
