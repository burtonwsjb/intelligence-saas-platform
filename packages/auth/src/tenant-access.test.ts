import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { member, tenant } from "@isp/db";
import { createAuth } from "./auth.js";
import { createMemoryInbox } from "./email.js";
import { OrganizationAccessError } from "./session.js";
import { createTestDatabase } from "./test-db.js";
import {
  TenantInactiveError,
  TenantNotFoundError,
  authorizeOrganizationSwitch,
  requireUsableTenant,
} from "./tenant-access.js";

const testEnv = {
  BETTER_AUTH_SECRET: "test-only-secret-not-for-production-use!!",
  BETTER_AUTH_URL: "http://localhost:3000",
  APP_URL: "http://localhost:3000",
  NODE_ENV: "test",
  AUTH_EMAIL_MODE: "memory",
};

function cookieHeader(response: Response): Headers {
  const headers = new Headers();
  const getSetCookie = response.headers.getSetCookie?.() ?? [];
  if (getSetCookie.length > 0) {
    headers.set("cookie", getSetCookie.map((part) => part.split(";")[0]).join("; "));
    return headers;
  }
  return headers;
}

describe("tenant switching and status", () => {
  it("allows a valid switch and rejects foreign, missing, and inactive tenants", async () => {
    const db = await createTestDatabase();
    const inbox = createMemoryInbox();
    const auth = createAuth({
      db,
      env: testEnv,
      emailDelivery: inbox.delivery,
    });

    async function register(email: string) {
      await auth.api.signUpEmail({
        body: { email, password: "correct-horse-battery", name: email },
      });
      const message = inbox.messages.find((item) => item.to === email);
      const token = new URL(message!.url).searchParams.get("token")!;
      await auth.api.verifyEmail({ query: { token } });
      const response = await auth.api.signInEmail({
        body: { email, password: "correct-horse-battery" },
        asResponse: true,
      });
      const headers = cookieHeader(response);
      const session = await auth.api.getSession({ headers });
      return { headers, userId: session!.user.id };
    }

    const userA = await register("switch-a@example.com");
    const userB = await register("switch-b@example.com");

    const orgA = await auth.api.createOrganization({
      headers: userA.headers,
      body: { name: "Tenant A", slug: "tenant-a-switch" },
    });
    const orgB = await auth.api.createOrganization({
      headers: userA.headers,
      body: { name: "Tenant B", slug: "tenant-b-switch" },
    });
    const orgC = await auth.api.createOrganization({
      headers: userB.headers,
      body: { name: "Tenant C", slug: "tenant-c-switch" },
    });

    await expect(
      authorizeOrganizationSwitch(db, {
        userId: userA.userId,
        requestedOrganizationId: orgB!.id,
      }),
    ).resolves.toEqual({ organizationId: orgB!.id, status: "active" });

    await expect(
      authorizeOrganizationSwitch(db, {
        userId: userA.userId,
        requestedOrganizationId: orgC!.id,
      }),
    ).rejects.toThrow(OrganizationAccessError);

    await expect(
      authorizeOrganizationSwitch(db, {
        userId: userA.userId,
        requestedOrganizationId: "missing-org",
      }),
    ).rejects.toThrow(OrganizationAccessError);

    await db
      .update(tenant)
      .set({ status: "suspended" })
      .where(eq(tenant.organizationId, orgA!.id));
    await expect(
      authorizeOrganizationSwitch(db, {
        userId: userA.userId,
        requestedOrganizationId: orgA!.id,
      }),
    ).rejects.toThrow(TenantInactiveError);
    await expect(requireUsableTenant(db, orgA!.id, userA.userId)).rejects.toThrow(
      TenantInactiveError,
    );

    await db
      .update(tenant)
      .set({ status: "deleted" })
      .where(eq(tenant.organizationId, orgB!.id));
    await expect(
      authorizeOrganizationSwitch(db, {
        userId: userA.userId,
        requestedOrganizationId: orgB!.id,
      }),
    ).rejects.toThrow(TenantInactiveError);

    await db.delete(member).where(eq(member.organizationId, orgC!.id));
    await expect(
      authorizeOrganizationSwitch(db, {
        userId: userB.userId,
        requestedOrganizationId: orgC!.id,
      }),
    ).rejects.toThrow(OrganizationAccessError);

    await expect(requireUsableTenant(db, "no-such-tenant", userA.userId)).rejects.toThrow(
      TenantNotFoundError,
    );

    await expect(
      authorizeOrganizationSwitch(db, {
        userId: userA.userId,
        requestedOrganizationId: { organizationId: orgC!.id },
      }),
    ).rejects.toThrow(OrganizationAccessError);
    await expect(
      authorizeOrganizationSwitch(db, {
        userId: userA.userId,
        requestedOrganizationId: "org'; drop table tenant --",
      }),
    ).rejects.toThrow(OrganizationAccessError);
  });
});
