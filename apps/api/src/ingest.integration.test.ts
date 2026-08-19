import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateApiKeySecret } from "@isp/auth";
import {
  applyMigrations,
  bootstrapRoles,
  createDbConnection,
  DB_ROLES,
  getMonthUsage,
  getOutboxJob,
  getSourceEvent,
  insertApiKey,
  listOutboxJobs,
  member,
  organization,
  replaceConnectionRole,
  requireDatabaseAdminUrl,
  tenant,
  tenantBilling,
  user,
  withMachineContext,
  withOrganizationContext,
  type Database,
} from "@isp/db";
import { dispatchPendingOutbox, requireRedisUrl } from "@isp/queue";
import { createApiApp } from "./app.js";

const passwords = {
  migrate: "isp_ci_migrate_only",
  user: "isp_ci_app_user_only",
  worker: "isp_ci_app_worker_only",
  admin: "isp_ci_app_admin_only",
};

const pepper = "phase05-integration-pepper-value";
const env = {
  ...process.env,
  NODE_ENV: "test",
  QUEUE_PREFIX: "phase05a",
  API_KEY_PEPPER: pepper,
};

function eventBody(overrides?: Record<string, unknown>) {
  return {
    event_type: "pricing.snapshot",
    occurred_at: "2026-08-16T00:00:00.000Z",
    idempotency_key: "src:price:sku_123:2026-08-16T00:00:00Z",
    entity: { type: "sku", external_id: "sku_123" },
    metrics: [{ key: "price.usd", value: 12.34, unit: "usd" }],
    payload: { source: "generic_http" },
    ...overrides,
  };
}

describe("POST /v1/events with Redis + Postgres", () => {
  let adminConn: ReturnType<typeof createDbConnection>;
  let appConn: ReturnType<typeof createDbConnection>;
  let db: Database;
  let orgId = "";
  let apiKey = "";
  let apiKeyId = "";

  beforeAll(async () => {
    requireRedisUrl(process.env);
    const adminUrl = requireDatabaseAdminUrl();
    await applyMigrations(adminUrl);
    await bootstrapRoles(adminUrl, passwords);
    adminConn = createDbConnection(adminUrl);
    appConn = createDbConnection(replaceConnectionRole(adminUrl, DB_ROLES.user, passwords.user));
    db = appConn.db;
    orgId = `org_${crypto.randomUUID()}`;
    const userId = `user_${crypto.randomUUID()}`;
    apiKeyId = `key_${crypto.randomUUID()}`;
    const generated = generateApiKeySecret(pepper);
    await adminConn.db.insert(user).values({
      id: userId,
      name: "Ingest",
      email: `${userId}@example.com`,
      emailVerified: true,
    });
    await adminConn.db.insert(organization).values({
      id: orgId,
      name: "Ingest",
      slug: orgId,
    });
    await adminConn.db.insert(member).values({
      id: `mem_${orgId}`,
      organizationId: orgId,
      userId,
      role: "owner",
    });
    await adminConn.db.insert(tenant).values({
      organizationId: orgId,
      status: "active",
      createdByUserId: userId,
    });
    await adminConn.db.insert(tenantBilling).values({
      organizationId: orgId,
      planKey: "free",
      status: "none",
    });
    await withOrganizationContext(db, { organizationId: orgId, userId }, (scoped) =>
      insertApiKey(scoped, {
        id: apiKeyId,
        organizationId: orgId,
        name: "ingest",
        prefix: generated.prefix,
        secretHash: generated.secretHash,
        scopes: "ingest:write",
        createdByUserId: userId,
      }),
    );
    apiKey = generated.fullKey;
  }, 60_000);

  afterAll(async () => {
    await appConn?.end();
    await adminConn?.end();
  });

  it("accepts ingest, meters once, and can publish a surviving outbox row", async () => {
    const app = createApiApp({ db, env });
    const first = await app.request("/v1/events", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-request-id": "req_phase05_http_1",
      },
      body: JSON.stringify(eventBody()),
    });
    expect(first.status).toBe(202);
    const accepted = (await first.json()) as { event_id: string };
    const replay = await app.request("/v1/events", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(eventBody()),
    });
    expect(replay.status).toBe(202);
    await expect(replay.json()).resolves.toEqual({ event_id: accepted.event_id, accepted: true });

    const usage = await withMachineContext(
      db,
      { organizationId: orgId, apiKeyId },
      (scoped) => getMonthUsage(scoped, { organizationId: orgId, meterKey: "ingest.events" }),
    );
    expect(usage).toBe(1);

    const stored = await withMachineContext(db, { organizationId: orgId, apiKeyId }, (scoped) =>
      getSourceEvent(scoped, { organizationId: orgId, id: accepted.event_id }),
    );
    expect(stored?.organizationId).toBe(orgId);
    expect(["received", "queued", "processing", "processed"]).toContain(stored?.processingStatus);

    await dispatchPendingOutbox(db, { env, limit: 50 });
    const jobs = await withMachineContext(db, { organizationId: orgId, apiKeyId }, (scoped) =>
      listOutboxJobs(scoped, orgId),
    );
    expect(jobs.every((job) => job.organizationId === orgId)).toBe(true);
    expect(jobs.some((job) => job.status === "published")).toBe(true);
    if (jobs[0]) {
      const row = await withMachineContext(db, { organizationId: orgId, apiKeyId }, (scoped) =>
        getOutboxJob(scoped, { organizationId: orgId, id: jobs[0]!.id }),
      );
      expect(row?.organizationId).toBe(orgId);
    }
  });
});
