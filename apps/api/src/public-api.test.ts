import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  CUSTOMER_READ_SCOPES,
  InvalidApiKeyLimitError,
  createOperatorApiKey,
  revokeOperatorApiKey,
  rotateOperatorApiKey,
  updateOperatorApiKeySettings,
} from "@isp/auth";
import {
  listOperatorApiKeys,
  organization,
  readMigrationSql,
  seedTcgIdentityFixtures,
  tenant,
  tenantBilling,
  user,
  type Database,
} from "@isp/db";
import { createApiApp } from "./app.js";
import { resetKeyRateLimiterForTests } from "./rate-limit.js";

const pepper = "public-api-test-pepper";

async function setup() {
  const client = new PGlite();
  await client.exec(await readMigrationSql());
  const db = drizzle(client) as unknown as Database;
  await db.insert(user).values({ id: "u_op", name: "Operator", email: "op@example.com", emailVerified: true });
  await db.insert(organization).values({ id: "o_cust", name: "Card Shop Co", slug: "card-shop" });
  await db.insert(tenant).values({ organizationId: "o_cust", status: "active", createdByUserId: "u_op" });
  await db.insert(tenantBilling).values({ organizationId: "o_cust", planKey: "scale", status: "active" });
  const env = { ...process.env, API_KEY_PEPPER: pepper } as NodeJS.ProcessEnv;
  const app = createApiApp({ db, env });
  return { client, db, app };
}

function get(app: ReturnType<typeof createApiApp>, path: string, key: string) {
  return app.request(path, { headers: { authorization: `Bearer ${key}` } });
}

describe("operator-issued public API keys", () => {
  beforeEach(() => resetKeyRateLimiterForTests());

  it("issues a key once, counts requests, enforces the per-key limit, rotates and revokes", async () => {
    const { db, app } = await setup();
    await seedTcgIdentityFixtures(db);
    const issued = await createOperatorApiKey(db, {
      organizationId: "o_cust",
      actorUserId: "u_op",
      name: "Card Shop Co read key",
      scopes: [...CUSTOMER_READ_SCOPES],
      pepper,
      rateLimitPerMinute: "3",
      note: "Pilot customer",
    });
    expect(issued.fullKey).toMatch(/^isp_(test|live)_[a-f0-9]{8}_/);

    const listed = await listOperatorApiKeys(db);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      organizationName: "Card Shop Co",
      rateLimitPerMinute: 3,
      requestCount: 0,
      note: "Pilot customer",
      issuedByOperator: true,
      status: "active",
    });
    // Only the HMAC is stored, never the key itself.
    const stored = await db.execute(`select secret_hash from api_key` as never);
    expect(JSON.stringify(stored)).not.toContain(issued.fullKey);

    const first = await get(app, "/v1/signals?market=buy&page_size=5", issued.fullKey);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-ratelimit-limit")).toBe("3");
    expect(first.headers.get("x-ratelimit-remaining")).toBe("2");
    const body = (await first.json()) as { data: unknown[]; page: number; page_size: number };
    expect(body.page).toBe(1);
    expect(body.page_size).toBe(5);
    expect(Array.isArray(body.data)).toBe(true);

    expect((await get(app, "/v1/sets", issued.fullKey)).status).toBe(200);
    expect((await get(app, "/v1/printings?limit=2", issued.fullKey)).status).toBe(200);
    const limited = await get(app, "/v1/sets", issued.fullKey);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe("rate_limited");

    expect((await listOperatorApiKeys(db))[0]!.requestCount).toBe(4);

    // Raising the limit takes effect on the next request.
    await updateOperatorApiKeySettings(db, {
      organizationId: "o_cust",
      apiKeyId: issued.id,
      actorUserId: "u_op",
      rateLimitPerMinute: "100",
      note: "Paid",
    });
    expect((await get(app, "/v1/sets", issued.fullKey)).status).toBe(200);

    // Write scopes were not granted.
    expect((await get(app, "/v1/webhooks", issued.fullKey)).status).toBe(403);

    const rotated = await rotateOperatorApiKey(db, { organizationId: "o_cust", apiKeyId: issued.id, actorUserId: "u_op", pepper });
    expect(rotated.fullKey).not.toBe(issued.fullKey);
    expect((await get(app, "/v1/sets", issued.fullKey)).status).toBe(401);
    expect((await get(app, "/v1/sets", rotated.fullKey)).status).toBe(200);
    const afterRotate = await listOperatorApiKeys(db);
    const replacement = afterRotate.find((row) => row.id === rotated.id)!;
    expect(replacement).toMatchObject({ rateLimitPerMinute: 100, note: "Paid", status: "active" });

    await revokeOperatorApiKey(db, { organizationId: "o_cust", apiKeyId: rotated.id, actorUserId: "u_op" });
    expect((await get(app, "/v1/sets", rotated.fullKey)).status).toBe(401);

    const audit = await db.execute(`select action from audit_event order by created_at` as never);
    const actions = JSON.stringify(audit);
    for (const action of ["api_key.created", "api_key.updated", "api_key.rotated", "api_key.revoked"]) {
      expect(actions).toContain(action);
    }
  });

  it("keeps keys without a per-key limit on today's behavior and rejects bad limits and filters", async () => {
    const { db, app } = await setup();
    const issued = await createOperatorApiKey(db, {
      organizationId: "o_cust",
      actorUserId: "u_op",
      name: "Unlimited",
      scopes: ["cards:read", "signals:read"],
      pepper,
      rateLimitPerMinute: "",
    });
    const res = await get(app, "/v1/sets", issued.fullKey);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ratelimit-limit")).toBeNull();
    expect((await get(app, "/v1/signals?sort=bogus", issued.fullKey)).status).toBe(400);
    expect((await get(app, "/v1/signals?page_size=49", issued.fullKey)).status).toBe(400);
    expect((await get(app, "/v1/signals?unknown=1", issued.fullKey)).status).toBe(400);
    await expect(
      createOperatorApiKey(db, {
        organizationId: "o_cust",
        actorUserId: "u_op",
        name: "Bad",
        scopes: ["cards:read"],
        pepper,
        rateLimitPerMinute: "0",
      }),
    ).rejects.toBeInstanceOf(InvalidApiKeyLimitError);
  });
});
