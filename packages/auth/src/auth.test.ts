import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { member, tenant } from "@isp/db";
import { createAuth, MissingAuthSecretError } from "./auth.js";
import { createMemoryInbox } from "./email.js";
import {
  AuthRequiredError,
  OrganizationRequiredError,
  requireActiveOrganization,
  requireSession,
} from "./session.js";
import { createTestDatabase } from "./test-db.js";
import { organizationRoles } from "./permissions.js";

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
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) {
    headers.set("cookie", setCookie.split(";")[0] ?? setCookie);
  }
  return headers;
}

describe("auth configuration", () => {
  it("loads Better Auth with organization roles", async () => {
    const db = await createTestDatabase();
    const inbox = createMemoryInbox();
    const auth = createAuth({
      db,
      env: testEnv,
      emailDelivery: inbox.delivery,
    });
    expect(auth.api.signUpEmail).toBeTypeOf("function");
    expect(Object.keys(organizationRoles)).toEqual([
      "owner",
      "admin",
      "developer",
      "analyst",
      "marketing",
      "billing",
      "viewer",
    ]);
  });

  it("rejects a missing auth secret", async () => {
    const db = await createTestDatabase();
    expect(() =>
      createAuth({
        db,
        env: { ...testEnv, BETTER_AUTH_SECRET: "short" },
      }),
    ).toThrow(MissingAuthSecretError);
  });
});

describe("signup, verification, session, and tenant", () => {
  it("creates a verified owner of the initial organization", async () => {
    const db = await createTestDatabase();
    const inbox = createMemoryInbox();
    const auth = createAuth({
      db,
      env: testEnv,
      emailDelivery: inbox.delivery,
    });

    await auth.api.signUpEmail({
      body: {
        email: "owner@example.com",
        password: "correct-horse-battery",
        name: "Owner",
      },
    });

    expect(inbox.messages).toHaveLength(1);
    const verifyUrl = new URL(inbox.messages[0]!.url);
    const token = verifyUrl.searchParams.get("token");
    expect(token).toBeTruthy();

    await auth.api.verifyEmail({
      query: { token: token! },
    });

    const signIn = await auth.api.signInEmail({
      body: {
        email: "owner@example.com",
        password: "correct-horse-battery",
      },
      asResponse: true,
    });
    expect(signIn.ok).toBe(true);
    const headers = cookieHeader(signIn);

    const session = await auth.api.getSession({ headers });
    requireSession(session);
    expect(session.user.email).toBe("owner@example.com");

    const created = await auth.api.createOrganization({
      headers,
      body: {
        name: "Acme Intelligence",
        slug: "acme-intelligence",
      },
    });
    expect(created?.name).toBe("Acme Intelligence");

    const active = await auth.api.setActiveOrganization({
      headers,
      body: { organizationId: created!.id },
    });
    expect(active?.id).toBe(created!.id);

    const sessionAfter = await auth.api.getSession({ headers });
    requireSession(sessionAfter);
    expect(requireActiveOrganization(sessionAfter)).toBe(created!.id);

    const [membership] = await db
      .select()
      .from(member)
      .where(eq(member.organizationId, created!.id));
    expect(membership?.userId).toBe(session.user.id);
    expect(membership?.role).toBe("owner");

    const [tenantRow] = await db
      .select()
      .from(tenant)
      .where(eq(tenant.organizationId, created!.id));
    expect(tenantRow?.createdByUserId).toBe(session.user.id);
    expect(tenantRow?.status).toBe("active");

    await auth.api.signOut({ headers });
    await expect(auth.api.getSession({ headers })).resolves.toBeNull();
  });

  it("does not let a user activate a foreign organization", async () => {
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
      return cookieHeader(response);
    }

    const ownerHeaders = await register("one@example.com");
    const otherHeaders = await register("two@example.com");

    const org = await auth.api.createOrganization({
      headers: ownerHeaders,
      body: { name: "Owner Org", slug: "owner-org" },
    });

    await expect(
      auth.api.setActiveOrganization({
        headers: otherHeaders,
        body: { organizationId: org!.id },
      }),
    ).rejects.toThrow();
  });
});

describe("session helpers", () => {
  it("rejects missing sessions", () => {
    expect(() => requireSession(null)).toThrow(AuthRequiredError);
  });

  it("rejects a session without an active organization", () => {
    expect(() =>
      requireActiveOrganization({
        session: { userId: "user_1", activeOrganizationId: null },
        user: { id: "user_1" },
      }),
    ).toThrow(OrganizationRequiredError);
  });
});
