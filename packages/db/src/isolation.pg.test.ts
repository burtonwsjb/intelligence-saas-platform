import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import {
  applyMigrations,
  bootstrapRoles,
  claimStripeEvent,
  createDbConnection,
  findOrganizationIdByStripeCustomer,
  DB_ROLES,
  deleteTenantResource,
  getTenantBilling,
  insertAuditEvent,
  insertOutboxJob,
  insertSourceEvent,
  insertTenantResource,
  listApiKeys,
  listOutboxJobs,
  listSourceEvents,
  listAuditEvents,
  listTenantResources,
  recordUsage,
  replaceConnectionRole,
  requireDatabaseAdminUrl,
  updateTenantResource,
  withMachineContext,
  withOrganizationContext,
  withSystemContext,
  type Database,
  IdentifierCollisionError,
  insertEntity,
  insertEntityIdentifier,
  insertObservation,
  insertObservationMetric,
  insertEvidenceReference,
  insertFeatureSnapshot,
  insertSignal,
  insertSignalEvidence,
  insertDecisionRecord,
  insertDecisionEvidence,
  listEntities,
  listEntityIdentifiers,
  listObservationsInRange,
  listObservationMetrics,
  listSignalsInRange,
  listFeatureSnapshotsInRange,
  listDecisionRecords,
  listSignalEvidence,
  entity,
  observation,
  featureSnapshot,
  signal,
  ensureTcgPrintingEntity,
  seedTcgIdentityFixtures,
  tcgGame,
  tcgMarketSnapshot,
  ingestTcgMarketRecord,
  ingestSourceContentRecord,
  sourceContent,
  withPlatformContext,
  seedTcgIdentityFixtures,
  resolveEntity,
  entityResolutionAttempt,
  extractCreatorCallsFromContent,
  creatorCallSourceFixtures,
  creatorCall,
  creatorAuthoritySlice,
  tcgMarketFeatureSnapshot,
  computeMarketFeatures,
  persistMarketFeatureSnapshot,
  tcgScoreSnapshot,
  tcgPrediction,
  webhookEndpoint,
} from "./index.js";

const passwords = {
  migrate: "isp_ci_migrate_only",
  user: "isp_ci_app_user_only",
  worker: "isp_ci_app_worker_only",
  admin: "isp_ci_app_admin_only",
};

const ids = {
  userA: "user_a",
  userB: "user_b",
  userAB: "user_ab",
  orgA: "org_a",
  orgB: "org_b",
  resourceA: "res_a",
  resourceB: "res_b",
};

function idsFromExecute(result: unknown): string[] {
  const rows = Array.isArray(result)
    ? result
    : result && typeof result === "object" && "rows" in result
      ? (result as { rows: unknown[] }).rows
      : Array.from(result as Iterable<unknown>);
  return rows.map((row) => (row as { id: string }).id);
}

describe("PostgreSQL RLS isolation", () => {
  let adminUrl: string;
  let admin: ReturnType<typeof postgres>;
  let appConn: ReturnType<typeof createDbConnection>;
  let appDb: Database;

  beforeAll(async () => {
    adminUrl = requireDatabaseAdminUrl();
    await applyMigrations(adminUrl);
    await bootstrapRoles(adminUrl, passwords);
    admin = postgres(adminUrl, { max: 1, prepare: false });
    appConn = createDbConnection(
      replaceConnectionRole(adminUrl, DB_ROLES.user, passwords.user),
    );
    appDb = appConn.db;

    await admin.unsafe(`
      INSERT INTO "user" (id, name, email, email_verified)
      VALUES
        ('${ids.userA}', 'User A', 'a@example.com', true),
        ('${ids.userB}', 'User B', 'b@example.com', true),
        ('${ids.userAB}', 'User AB', 'ab@example.com', true)
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO "organization" (id, name, slug)
      VALUES
        ('${ids.orgA}', 'Org A', 'org-a'),
        ('${ids.orgB}', 'Org B', 'org-b')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO "member" (id, organization_id, user_id, role)
      VALUES
        ('mem_a', '${ids.orgA}', '${ids.userA}', 'owner'),
        ('mem_b', '${ids.orgB}', '${ids.userB}', 'owner'),
        ('mem_ab_a', '${ids.orgA}', '${ids.userAB}', 'admin'),
        ('mem_ab_b', '${ids.orgB}', '${ids.userAB}', 'admin')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO "tenant" (organization_id, status, created_by_user_id)
      VALUES
        ('${ids.orgA}', 'active', '${ids.userA}'),
        ('${ids.orgB}', 'active', '${ids.userB}')
      ON CONFLICT (organization_id) DO UPDATE SET status = 'active';
      INSERT INTO "tenant_resource" (id, organization_id, title)
      VALUES
        ('${ids.resourceA}', '${ids.orgA}', 'Alpha'),
        ('${ids.resourceB}', '${ids.orgB}', 'Beta')
      ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title;
      INSERT INTO "tenant_billing" (organization_id, plan_key, status)
      VALUES
        ('${ids.orgA}', 'free', 'none'),
        ('${ids.orgB}', 'free', 'none')
      ON CONFLICT (organization_id) DO NOTHING;
      INSERT INTO "api_key" (id, organization_id, name, prefix, secret_hash, scopes, status)
      VALUES
        ('key_a', '${ids.orgA}', 'A', 'isp_test_aaaaaaaa', 'hash_a', 'decisions:read', 'active'),
        ('key_b', '${ids.orgB}', 'B', 'isp_test_bbbbbbbb', 'hash_b', 'decisions:read', 'active')
      ON CONFLICT (id) DO NOTHING;
    `);
  }, 60_000);

  afterAll(async () => {
    await appConn?.end();
    await admin?.end({ timeout: 5 });
  });

  async function asUser<T>(
    userId: string,
    organizationId: string,
    run: (db: Database) => Promise<T>,
  ): Promise<T> {
    return withOrganizationContext(appDb, { userId, organizationId }, run);
  }

  it("lets tenant A read A and not B", async () => {
    const rows = await asUser(ids.userA, ids.orgA, (db) =>
      listTenantResources(db, ids.orgA),
    );
    expect(rows.map((row) => row.id)).toEqual([ids.resourceA]);
    const hop = await asUser(ids.userA, ids.orgA, (db) =>
      listTenantResources(db, ids.orgB),
    );
    expect(hop).toEqual([]);
  });

  it("prevents A from inserting, updating, or deleting B", async () => {
    await expect(
      asUser(ids.userA, ids.orgA, (db) =>
        insertTenantResource(db, {
          id: "res_hop",
          organizationId: ids.orgB,
          title: "hop",
        }),
      ),
    ).rejects.toThrow();

    await expect(
      asUser(ids.userA, ids.orgA, (db) =>
        updateTenantResource(db, {
          id: ids.resourceB,
          organizationId: ids.orgB,
          title: "hacked",
        }),
      ),
    ).resolves.toBe(0);

    await expect(
      asUser(ids.userA, ids.orgA, (db) =>
        deleteTenantResource(db, { id: ids.resourceB, organizationId: ids.orgB }),
      ),
    ).resolves.toBe(0);
  });

  it("prevents B from reading A", async () => {
    const rows = await asUser(ids.userB, ids.orgB, (db) =>
      listTenantResources(db, ids.orgA),
    );
    expect(rows).toEqual([]);
  });

  it("returns no tenant-owned rows without context", async () => {
    await expect(listTenantResources(appDb, ids.orgA)).rejects.toThrow(
      /Tenant context is required/,
    );
    const raw = postgres(replaceConnectionRole(adminUrl, DB_ROLES.user, passwords.user), {
      max: 1,
      prepare: false,
    });
    try {
      const rows = await raw`select id from tenant_resource`;
      expect(rows).toHaveLength(0);
    } finally {
      await raw.end({ timeout: 5 });
    }
  });

  it("fails closed for the wrong tenant context", async () => {
    const rows = await asUser(ids.userA, ids.orgB, (db) =>
      listTenantResources(db, ids.orgB),
    );
    expect(rows).toEqual([]);
  });

  it("limits a multi-org user to the active tenant only", async () => {
    const activeA = await asUser(ids.userAB, ids.orgA, (db) =>
      listTenantResources(db, ids.orgA),
    );
    expect(activeA.map((row) => row.id)).toEqual([ids.resourceA]);
    const leak = await asUser(ids.userAB, ids.orgA, (db) =>
      db.execute(sql`select id from tenant_resource`),
    );
    expect(idsFromExecute(leak)).toEqual([ids.resourceA]);

    const activeB = await asUser(ids.userAB, ids.orgB, (db) =>
      listTenantResources(db, ids.orgB),
    );
    expect(activeB.map((row) => row.id)).toEqual([ids.resourceB]);
  });

  it("ignores a client-supplied foreign organization id while scoped to A", async () => {
    const rows = await asUser(ids.userAB, ids.orgA, (db) =>
      listTenantResources(db, ids.orgB),
    );
    expect(rows).toEqual([]);
  });

  it("blocks tenant_resource access when the tenant is suspended or deleted", async () => {
    await admin`update tenant set status = 'suspended' where organization_id = ${ids.orgA}`;
    await expect(
      asUser(ids.userA, ids.orgA, (db) => listTenantResources(db, ids.orgA)),
    ).resolves.toEqual([]);
    await expect(
      asUser(ids.userA, ids.orgA, (db) =>
        insertTenantResource(db, {
          id: "res_suspended",
          organizationId: ids.orgA,
          title: "nope",
        }),
      ),
    ).rejects.toThrow();

    await admin`update tenant set status = 'deleted' where organization_id = ${ids.orgB}`;
    await expect(
      asUser(ids.userB, ids.orgB, (db) => listTenantResources(db, ids.orgB)),
    ).resolves.toEqual([]);

    await admin`update tenant set status = 'active' where organization_id in (${ids.orgA}, ${ids.orgB})`;
  });

  it("keeps the application role from bypassing RLS or escalating", async () => {
    const raw = postgres(replaceConnectionRole(adminUrl, DB_ROLES.user, passwords.user), {
      max: 1,
      prepare: false,
    });
    try {
      const [role] = await raw<
        { current_user: string; rolsuper: boolean; rolbypassrls: boolean }[]
      >`
        select current_user, rolsuper, rolbypassrls
        from pg_roles
        where rolname = current_user
      `;
      expect(role?.current_user).toBe(DB_ROLES.user);
      expect(role?.rolsuper).toBe(false);
      expect(role?.rolbypassrls).toBe(false);

      await expect(raw.unsafe(`set role ${DB_ROLES.migrate}`)).rejects.toThrow();
      await expect(raw.unsafe(`set role ${DB_ROLES.admin}`)).rejects.toThrow();
      await expect(
        raw.unsafe(`alter table tenant disable row level security`),
      ).rejects.toThrow();
      await expect(
        raw.unsafe(`alter policy tenant_select on tenant using (true)`),
      ).rejects.toThrow();
    } finally {
      await raw.end({ timeout: 5 });
    }
  });

  it("prevents the application role from rewriting audit history", async () => {
    const auditId = `audit_${crypto.randomUUID()}`;
    await asUser(ids.userA, ids.orgA, (db) =>
      insertAuditEvent(db, {
        id: auditId,
        organizationId: ids.orgA,
        actorUserId: ids.userA,
        action: "organization.switch",
      }),
    );
    const events = await asUser(ids.userA, ids.orgA, (db) =>
      listAuditEvents(db, ids.orgA),
    );
    expect(events.some((event) => event.id === auditId)).toBe(true);

    const raw = postgres(replaceConnectionRole(adminUrl, DB_ROLES.user, passwords.user), {
      max: 1,
      prepare: false,
    });
    try {
      await expect(
        raw.unsafe(`update audit_event set action = 'forged' where id = '${auditId}'`),
      ).rejects.toThrow();
      await expect(raw.unsafe(`delete from audit_event where id = '${auditId}'`)).rejects.toThrow();
    } finally {
      await raw.end({ timeout: 5 });
    }
  });

  it("keeps API keys and billing rows inside the active tenant", async () => {
    const keys = await asUser(ids.userA, ids.orgA, (db) => listApiKeys(db, ids.orgA));
    expect(keys.map((key) => key.id)).toEqual(["key_a"]);
    const hop = await asUser(ids.userA, ids.orgA, (db) => listApiKeys(db, ids.orgB));
    expect(hop).toEqual([]);
    const billing = await asUser(ids.userA, ids.orgA, (db) => getTenantBilling(db, ids.orgA));
    expect(billing?.organizationId).toBe(ids.orgA);
    const foreignBilling = await asUser(ids.userA, ids.orgA, (db) =>
      getTenantBilling(db, ids.orgB),
    );
    expect(foreignBilling).toBeNull();
  });

  it("binds machine principals to the key tenant and rejects hops", async () => {
    const own = await withMachineContext(
      appDb,
      { organizationId: ids.orgA, apiKeyId: "key_a" },
      (db) => listApiKeys(db, ids.orgA),
    );
    expect(own.map((key) => key.id)).toEqual(["key_a"]);
    const hop = await withMachineContext(
      appDb,
      { organizationId: ids.orgA, apiKeyId: "key_a" },
      (db) => listApiKeys(db, ids.orgB),
    );
    expect(hop).toEqual([]);
    const wrongTenant = await withMachineContext(
      appDb,
      { organizationId: ids.orgB, apiKeyId: "key_a" },
      (db) => listApiKeys(db, ids.orgB),
    );
    expect(wrongTenant).toEqual([]);
  });

  it("stores API key hashes, not plaintext secrets", async () => {
    const rows = await admin<{ secret_hash: string; prefix: string }[]>`
      select secret_hash, prefix from api_key where id = 'key_a'
    `;
    expect(rows[0]?.prefix).toBe("isp_test_aaaaaaaa");
    expect(rows[0]?.secret_hash).toBe("hash_a");
    expect(rows[0]?.secret_hash).not.toMatch(/^isp_test_/);
  });

  it("maps a Stripe customer to exactly one tenant and fails closed otherwise", async () => {
    await admin`
      update tenant_billing
      set stripe_customer_id = 'cus_testPhase04A'
      where organization_id = ${ids.orgA}
    `;
    await expect(findOrganizationIdByStripeCustomer(appDb, "cus_testPhase04A")).resolves.toBe(
      ids.orgA,
    );
    await expect(findOrganizationIdByStripeCustomer(appDb, "cus_unknown")).resolves.toBeNull();
    await expect(findOrganizationIdByStripeCustomer(appDb, "not-a-customer")).resolves.toBeNull();
  });

  it("denies revoked machine keys and inactive-tenant machine writes", async () => {
    await admin`update api_key set status = 'revoked', revoked_at = now() where id = 'key_a'`;
    const revoked = await withMachineContext(
      appDb,
      { organizationId: ids.orgA, apiKeyId: "key_a" },
      (db) => listApiKeys(db, ids.orgA),
    );
    expect(revoked).toEqual([]);
    await admin`update api_key set status = 'active', revoked_at = null where id = 'key_a'`;

    await admin`update tenant set status = 'suspended' where organization_id = ${ids.orgA}`;
    await expect(
      withMachineContext(appDb, { organizationId: ids.orgA, apiKeyId: "key_a" }, (db) =>
        recordUsage(db, {
          id: "usage_suspended",
          organizationId: ids.orgA,
          meterKey: "api.reads",
          quantity: 1,
        }),
      ),
    ).rejects.toThrow();
    await admin`update tenant set status = 'active' where organization_id = ${ids.orgA}`;
  });

  it("keeps source events and outbox jobs inside the active tenant", async () => {
    const eventA = `src_${crypto.randomUUID()}`;
    const eventB = `src_${crypto.randomUUID()}`;
    await asUser(ids.userA, ids.orgA, (db) =>
      insertSourceEvent(db, {
        id: eventA,
        organizationId: ids.orgA,
        eventType: "pricing.snapshot",
        occurredAt: new Date(),
        idempotencyKey: `idem_${crypto.randomUUID()}`,
        fingerprint: "fp_a",
        entity: { type: "sku", external_id: "a" },
        metrics: [],
        payload: {},
      }),
    );
    await asUser(ids.userB, ids.orgB, (db) =>
      insertSourceEvent(db, {
        id: eventB,
        organizationId: ids.orgB,
        eventType: "pricing.snapshot",
        occurredAt: new Date(),
        idempotencyKey: `idem_${crypto.randomUUID()}`,
        fingerprint: "fp_b",
        entity: { type: "sku", external_id: "b" },
        metrics: [],
        payload: {},
      }),
    );
    const own = await asUser(ids.userA, ids.orgA, (db) => listSourceEvents(db, ids.orgA));
    expect(own.map((row) => row.id)).toContain(eventA);
    const hop = await asUser(ids.userA, ids.orgA, (db) => listSourceEvents(db, ids.orgB));
    expect(hop).toEqual([]);

    await asUser(ids.userA, ids.orgA, (db) =>
      insertOutboxJob(db, {
        id: `out_${crypto.randomUUID()}`,
        organizationId: ids.orgA,
        sourceEventId: eventA,
        jobType: "source_event.normalize",
        payload: { job_id: "job" },
      }),
    );
    const outbox = await asUser(ids.userA, ids.orgA, (db) => listOutboxJobs(db, ids.orgA));
    expect(outbox.every((row) => row.organizationId === ids.orgA)).toBe(true);
    const outboxHop = await asUser(ids.userA, ids.orgA, (db) => listOutboxJobs(db, ids.orgB));
    expect(outboxHop).toEqual([]);
  });

  it("claims Stripe events once", async () => {
    const eventId = `evt_${crypto.randomUUID()}`;
    await expect(
      claimStripeEvent(appDb, {
        id: eventId,
        type: "invoice.paid",
        organizationId: ids.orgA,
        stripeCustomerId: "cus_test_a",
      }),
    ).resolves.toBe(true);
    await expect(
      claimStripeEvent(appDb, {
        id: eventId,
        type: "invoice.paid",
        organizationId: ids.orgA,
        stripeCustomerId: "cus_test_a",
      }),
    ).resolves.toBe(false);
  });

  it("isolates kernel rows, rejects cross-tenant evidence, and preserves historical order", async () => {
    const eventA1 = crypto.randomUUID();
    const eventA2 = crypto.randomUUID();
    const eventB = crypto.randomUUID();
    const entityA = `ent_a_${crypto.randomUUID()}`;
    const entityB = `ent_b_${crypto.randomUUID()}`;
    const evidenceA = `evr_a_${crypto.randomUUID()}`;
    const evidenceB = `evr_b_${crypto.randomUUID()}`;
    const snapshotA = `fs_a_${crypto.randomUUID()}`;
    const snapshotB = `fs_b_${crypto.randomUUID()}`;
    const signalA = `sig_a_${crypto.randomUUID()}`;
    const signalB = `sig_b_${crypto.randomUUID()}`;
    const decisionA = `dec_a_${crypto.randomUUID()}`;
    const decisionB = `dec_b_${crypto.randomUUID()}`;
    const skuA = `sku-a-${crypto.randomUUID()}`;
    const skuB = `sku-b-${crypto.randomUUID()}`;

    await asUser(ids.userA, ids.orgA, async (db) => {
      await insertSourceEvent(db, {
        id: eventA1,
        organizationId: ids.orgA,
        eventType: "pricing.snapshot",
        occurredAt: new Date("2026-01-01T00:00:00.000Z"),
        idempotencyKey: `idem_${eventA1}`,
        fingerprint: `fp_${eventA1}`,
        entity: { type: "sku", external_id: skuA },
        metrics: [{ key: "price.usd", value: 1 }],
        payload: {},
      });
      await insertSourceEvent(db, {
        id: eventA2,
        organizationId: ids.orgA,
        eventType: "pricing.snapshot",
        occurredAt: new Date("2026-03-01T00:00:00.000Z"),
        idempotencyKey: `idem_${eventA2}`,
        fingerprint: `fp_${eventA2}`,
        entity: { type: "sku", external_id: skuA },
        metrics: [{ key: "price.usd", value: 2 }],
        payload: {},
      });
      await insertEntity(db, {
        id: entityA,
        organizationId: ids.orgA,
        entityType: "sku",
        canonicalKey: `sku:ingest:sku:${skuA}`,
      });
      await insertEntityIdentifier(db, {
        id: `eid_a_${crypto.randomUUID()}`,
        organizationId: ids.orgA,
        entityId: entityA,
        sourceNamespace: "ingest",
        identifierType: "sku",
        identifierValue: skuA,
        normalizedValue: skuA,
      });
      await insertObservation(db, {
        id: eventA1,
        organizationId: ids.orgA,
        entityId: entityA,
        sourceEventId: eventA1,
        sourceNamespace: "ingest",
        observationType: "metric.snapshot",
        observedAt: new Date("2026-01-01T00:00:00.000Z"),
        receivedAt: new Date("2026-01-02T00:00:00.000Z"),
        qualityFlag: "complete",
      });
      await insertObservation(db, {
        id: eventA2,
        organizationId: ids.orgA,
        entityId: entityA,
        sourceEventId: eventA2,
        sourceNamespace: "ingest",
        observationType: "metric.snapshot",
        observedAt: new Date("2026-03-01T00:00:00.000Z"),
        receivedAt: new Date("2026-03-02T00:00:00.000Z"),
        qualityFlag: "complete",
      });
      await insertObservationMetric(db, {
        id: `met_a_${crypto.randomUUID()}`,
        organizationId: ids.orgA,
        observationId: eventA1,
        metricKey: "price.usd",
        numericValue: "1.00000000",
        unit: "usd",
      });
      await insertEvidenceReference(db, {
        id: evidenceA,
        organizationId: ids.orgA,
        evidenceType: "observation",
        sourceEventId: eventA1,
        observationId: eventA1,
        capturedAt: new Date("2026-01-02T00:00:00.000Z"),
      });
      await insertFeatureSnapshot(db, {
        id: snapshotA,
        organizationId: ids.orgA,
        entityId: entityA,
        featureSetKey: "ingest.v1",
        featureSetVersion: "1",
        features: { price: 1 },
        fingerprint: "fingerprint_a_value",
        asOf: new Date("2026-01-01T00:00:00.000Z"),
      });
      await insertSignal(db, {
        id: signalA,
        organizationId: ids.orgA,
        entityId: entityA,
        signalType: "snapshot",
        direction: "unknown",
        confidence: "1.0000",
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
        algorithmKey: "kernel.normalize",
        algorithmVersion: "1",
        featureSnapshotId: snapshotA,
      });
      await insertSignalEvidence(db, {
        id: `se_a_${crypto.randomUUID()}`,
        organizationId: ids.orgA,
        signalId: signalA,
        evidenceReferenceId: evidenceA,
        observationId: eventA1,
        role: "primary",
      });
    });

    await asUser(ids.userB, ids.orgB, async (db) => {
      await insertSourceEvent(db, {
        id: eventB,
        organizationId: ids.orgB,
        eventType: "pricing.snapshot",
        occurredAt: new Date("2026-02-01T00:00:00.000Z"),
        idempotencyKey: `idem_${eventB}`,
        fingerprint: `fp_${eventB}`,
        entity: { type: "sku", external_id: skuB },
        metrics: [],
        payload: {},
      });
      await insertEntity(db, {
        id: entityB,
        organizationId: ids.orgB,
        entityType: "sku",
        canonicalKey: `sku:ingest:sku:${skuB}`,
      });
      await insertObservation(db, {
        id: eventB,
        organizationId: ids.orgB,
        entityId: entityB,
        sourceEventId: eventB,
        sourceNamespace: "ingest",
        observationType: "metric.snapshot",
        observedAt: new Date("2026-02-01T00:00:00.000Z"),
        receivedAt: new Date("2026-02-01T00:00:00.000Z"),
        qualityFlag: "partial",
      });
      await insertObservationMetric(db, {
        id: `met_b_${crypto.randomUUID()}`,
        organizationId: ids.orgB,
        observationId: eventB,
        metricKey: "price.usd",
        numericValue: "9.00000000",
        unit: "usd",
      });
      await insertEvidenceReference(db, {
        id: evidenceB,
        organizationId: ids.orgB,
        evidenceType: "observation",
        sourceEventId: eventB,
        observationId: eventB,
        capturedAt: new Date("2026-02-01T00:00:00.000Z"),
      });
      await insertFeatureSnapshot(db, {
        id: snapshotB,
        organizationId: ids.orgB,
        entityId: entityB,
        featureSetKey: "ingest.v1",
        featureSetVersion: "1",
        features: { price: 9 },
        fingerprint: "fingerprint_b_value",
        asOf: new Date("2026-02-01T00:00:00.000Z"),
      });
      await insertSignal(db, {
        id: signalB,
        organizationId: ids.orgB,
        entityId: entityB,
        signalType: "snapshot",
        direction: "unknown",
        confidence: "0.5000",
        validFrom: new Date("2026-02-01T00:00:00.000Z"),
        algorithmKey: "kernel.normalize",
        algorithmVersion: "1",
        featureSnapshotId: snapshotB,
      });
      await insertDecisionRecord(db, {
        id: decisionB,
        organizationId: ids.orgB,
        entityId: entityB,
        decisionType: "review.flag",
        confidence: "0.5000",
        policyKey: "kernel.placeholder",
        policyVersion: "1",
        featureSnapshotId: snapshotB,
        result: { tenant: "b" },
      });
    });

    await asUser(ids.userA, ids.orgA, async (db) => {
      await insertDecisionRecord(db, {
        id: decisionA,
        organizationId: ids.orgA,
        entityId: entityA,
        decisionType: "review.flag",
        confidence: "0.2500",
        policyKey: "kernel.placeholder",
        policyVersion: "1",
        featureSnapshotId: snapshotA,
        result: { tenant: "a" },
      });
      await insertDecisionEvidence(db, {
        id: `de_a_${crypto.randomUUID()}`,
        organizationId: ids.orgA,
        decisionId: decisionA,
        signalId: signalA,
        role: "cited",
      });
    });

    const ownEntities = await asUser(ids.userA, ids.orgA, (db) => listEntities(db, ids.orgA));
    expect(ownEntities.map((row) => row.id)).toContain(entityA);
    expect(await asUser(ids.userA, ids.orgA, (db) => listEntities(db, ids.orgB))).toEqual([]);

    const ownObs = await asUser(ids.userA, ids.orgA, (db) =>
      listObservationsInRange(db, {
        organizationId: ids.orgA,
        entityId: entityA,
        from: new Date("2025-01-01T00:00:00.000Z"),
        to: new Date("2026-12-01T00:00:00.000Z"),
      }),
    );
    expect(ownObs.map((row) => row.id)).toEqual([eventA1, eventA2]);
    expect(
      await asUser(ids.userA, ids.orgA, (db) =>
        listObservationsInRange(db, {
          organizationId: ids.orgB,
          from: new Date("2025-01-01T00:00:00.000Z"),
          to: new Date("2026-12-01T00:00:00.000Z"),
        }),
      ),
    ).toEqual([]);

    expect(
      await asUser(ids.userA, ids.orgA, (db) =>
        listObservationMetrics(db, { organizationId: ids.orgB, observationId: eventB }),
      ),
    ).toEqual([]);
    expect(
      await asUser(ids.userA, ids.orgA, (db) =>
        listSignalsInRange(db, {
          organizationId: ids.orgB,
          from: new Date("2025-01-01T00:00:00.000Z"),
          to: new Date("2026-12-01T00:00:00.000Z"),
        }),
      ),
    ).toEqual([]);
    expect(
      await asUser(ids.userA, ids.orgA, (db) =>
        listFeatureSnapshotsInRange(db, {
          organizationId: ids.orgB,
          from: new Date("2025-01-01T00:00:00.000Z"),
          to: new Date("2026-12-01T00:00:00.000Z"),
        }),
      ),
    ).toEqual([]);
    expect(await asUser(ids.userA, ids.orgA, (db) => listDecisionRecords(db, ids.orgB))).toEqual([]);

    await expect(
      asUser(ids.userA, ids.orgA, (db) =>
        insertSignalEvidence(db, {
          id: `se_hop_${crypto.randomUUID()}`,
          organizationId: ids.orgA,
          signalId: signalA,
          evidenceReferenceId: evidenceB,
          observationId: eventA1,
        }),
      ),
    ).rejects.toThrow();

    await expect(
      asUser(ids.userA, ids.orgA, async (db) => {
        const hopEvent = crypto.randomUUID();
        await insertSourceEvent(db, {
          id: hopEvent,
          organizationId: ids.orgA,
          eventType: "pricing.snapshot",
          occurredAt: new Date("2026-04-01T00:00:00.000Z"),
          idempotencyKey: `idem_${hopEvent}`,
          fingerprint: `fp_${hopEvent}`,
          entity: { type: "sku", external_id: "hop" },
          metrics: [],
          payload: {},
        });
        await insertObservation(db, {
          id: hopEvent,
          organizationId: ids.orgA,
          entityId: entityB,
          sourceEventId: hopEvent,
          sourceNamespace: "ingest",
          observationType: "metric.snapshot",
          observedAt: new Date("2026-04-01T00:00:00.000Z"),
          receivedAt: new Date("2026-04-01T00:00:00.000Z"),
        });
      }),
    ).rejects.toThrow();

    await expect(
      withSystemContext(appDb, { organizationId: ids.orgA }, async (db) => {
        const hopEvent = crypto.randomUUID();
        await insertSourceEvent(db, {
          id: hopEvent,
          organizationId: ids.orgA,
          eventType: "pricing.snapshot",
          occurredAt: new Date("2026-04-02T00:00:00.000Z"),
          idempotencyKey: `idem_${hopEvent}`,
          fingerprint: `fp_${hopEvent}`,
          entity: { type: "sku", external_id: "hop-system" },
          metrics: [],
          payload: {},
        });
        await insertObservation(db, {
          id: hopEvent,
          organizationId: ids.orgA,
          entityId: entityB,
          sourceEventId: hopEvent,
          sourceNamespace: "ingest",
          observationType: "metric.snapshot",
          observedAt: new Date("2026-04-02T00:00:00.000Z"),
          receivedAt: new Date("2026-04-02T00:00:00.000Z"),
        });
      }),
    ).rejects.toThrow();

    await expect(
      asUser(ids.userA, ids.orgA, (db) =>
        db.update(observation).set({ qualityFlag: "stale" }).where(eq(observation.id, eventA1)),
      ),
    ).rejects.toThrow();
    await expect(
      asUser(ids.userA, ids.orgA, (db) =>
        db.delete(observation).where(eq(observation.id, eventA1)),
      ),
    ).rejects.toThrow();
    await expect(
      asUser(ids.userA, ids.orgA, (db) =>
        db
          .update(featureSnapshot)
          .set({ fingerprint: "rewritten" })
          .where(eq(featureSnapshot.id, snapshotA)),
      ),
    ).rejects.toThrow();
    await expect(
      asUser(ids.userA, ids.orgA, (db) =>
        db.update(signal).set({ confidence: "0.1000" }).where(eq(signal.id, signalA)),
      ),
    ).rejects.toThrow();
    await expect(
      asUser(ids.userA, ids.orgA, (db) =>
        db.update(entity).set({ canonicalKey: "hacked" }).where(eq(entity.id, entityA)),
      ),
    ).rejects.toThrow();

    await expect(
      asUser(ids.userA, ids.orgA, async (db) => {
        const other = await insertEntity(db, {
          id: `ent_a2_${crypto.randomUUID()}`,
          organizationId: ids.orgA,
          entityType: "sku",
          canonicalKey: `sku:ingest:sku:other-${skuA}`,
        });
        await insertEntityIdentifier(db, {
          id: `eid_a2_${crypto.randomUUID()}`,
          organizationId: ids.orgA,
          entityId: other!.id,
          sourceNamespace: "ingest",
          identifierType: "sku",
          identifierValue: skuA,
          normalizedValue: skuA,
        });
      }),
    ).rejects.toBeInstanceOf(IdentifierCollisionError);

    const identifiers = await asUser(ids.userA, ids.orgA, (db) =>
      listEntityIdentifiers(db, ids.orgA),
    );
    expect(identifiers.every((row) => row.organizationId === ids.orgA)).toBe(true);
    const evidence = await asUser(ids.userA, ids.orgA, (db) =>
      listSignalEvidence(db, { organizationId: ids.orgA, signalId: signalA }),
    );
    expect(evidence).toHaveLength(1);
  });

  it("prevents tenants from mutating global TCG canonical identity", async () => {
    const adminConn = createDbConnection(adminUrl);
    try {
      const seeded = await seedTcgIdentityFixtures(adminConn.db);
      const raw = postgres(replaceConnectionRole(adminUrl, DB_ROLES.user, passwords.user), {
        max: 1,
        prepare: false,
      });
      try {
        const games = await raw`select game_key from tcg_game where game_key = 'pokemon'`;
        expect(games).toHaveLength(1);
        await expect(
          raw`insert into tcg_game (game_key, display_name) values ('hacked_game', 'Hacked')`,
        ).rejects.toThrow();
        await expect(
          raw`update tcg_game set display_name = 'Hacked' where game_key = 'pokemon'`,
        ).rejects.toThrow();
        await expect(raw`delete from tcg_game where game_key = 'pokemon'`).rejects.toThrow();
        await expect(
          raw`insert into tcg_set (id, game_key, canonical_set_key, name) values ('set_hack', 'pokemon', 'hacked', 'Hacked')`,
        ).rejects.toThrow();
        await expect(
          raw`update tcg_set set name = 'Hacked' where id = ${seeded.sets.twm.id}`,
        ).rejects.toThrow();
        await expect(
          raw`insert into tcg_card_concept (id, game_key, concept_key, canonical_name, normalized_name) values ('crd_hack', 'pokemon', 'hacked', 'Hacked', 'Hacked')`,
        ).rejects.toThrow();
        await expect(
          raw`update tcg_card_concept set canonical_name = 'Hacked' where id = ${seeded.concepts.greninja.id}`,
        ).rejects.toThrow();
        await expect(
          raw`update tcg_printing set collector_number = '000' where id = ${seeded.printings.greninjaEnNormal.id}`,
        ).rejects.toThrow();
        await expect(
          raw`delete from tcg_printing where id = ${seeded.printings.greninjaEnNormal.id}`,
        ).rejects.toThrow();
      } finally {
        await raw.end({ timeout: 5 });
      }

      await expect(
        asUser(ids.userA, ids.orgA, (db) =>
          db.insert(tcgGame).values({
            gameKey: "tenant_hack",
            displayName: "Should fail",
          }),
        ),
      ).rejects.toThrow();

      const entityA = await asUser(ids.userA, ids.orgA, (db) =>
        ensureTcgPrintingEntity(db, {
          organizationId: ids.orgA,
          printing: seeded.printings.greninjaEnNormal,
        }),
      );
      const entityB = await asUser(ids.userB, ids.orgB, (db) =>
        ensureTcgPrintingEntity(db, {
          organizationId: ids.orgB,
          printing: seeded.printings.greninjaEnNormal,
        }),
      );
      expect(entityA.entityType).toBe("tcg_printing");
      expect(entityA.id).not.toBe(entityB.id);
      expect(await asUser(ids.userA, ids.orgA, (db) => listEntities(db, ids.orgB))).toEqual([]);
    } finally {
      await adminConn.end();
    }
  });

  it("prevents tenants from mutating global TCG market facts", async () => {
    const adminConn = createDbConnection(adminUrl);
    try {
      const seeded = await seedTcgIdentityFixtures(adminConn.db);
      const ingested = await withPlatformContext(adminConn.db, (db) =>
        ingestTcgMarketRecord(db, {
          provider: "fixture",
          provider_record_id: `iso_sold_${crypto.randomUUID()}`,
          event_type: "tcg.market.sold",
          market_type: "marketplace_sold",
          price_type: "sold",
          observed_at: "2026-01-01T00:00:00.000Z",
          currency: "USD",
          condition: "nm",
          price: 40,
          printing: {
            game: "pokemon",
            set: "twm",
            collector_number: "214/167",
            language: "en",
            variant: "normal",
          },
        }),
      );
      expect(ingested.status).toBe("processed");
      const raw = postgres(replaceConnectionRole(adminUrl, DB_ROLES.user, passwords.user), {
        max: 1,
        prepare: false,
      });
      try {
        const rows = await raw`select id from tcg_market_snapshot where printing_id = ${seeded.printings.greninjaEnNormal.id}`;
        expect(rows.length).toBeGreaterThan(0);
        await expect(
          raw`insert into tcg_market_snapshot (
            id, printing_id, source_key, market_type, price_type, observed_at, currency, condition, source_record_id, fingerprint
          ) values (
            'msn_hack', ${seeded.printings.greninjaEnNormal.id}, 'fixture', 'marketplace_sold', 'sold', now(), 'USD', 'nm', 'hack', 'fp'
          )`,
        ).rejects.toThrow();
        await expect(
          raw`update tcg_market_snapshot set price = 1 where id = ${ingested.snapshotId}`,
        ).rejects.toThrow();
        await expect(
          raw`delete from tcg_market_snapshot where id = ${ingested.snapshotId}`,
        ).rejects.toThrow();
      } finally {
        await raw.end({ timeout: 5 });
      }

      await expect(
        asUser(ids.userA, ids.orgA, (db) =>
          db.insert(tcgMarketSnapshot).values({
            id: "msn_tenant_hack",
            printingId: seeded.printings.greninjaEnNormal.id,
            sourceKey: "fixture",
            marketType: "marketplace_sold",
            priceType: "sold",
            observedAt: new Date(),
            currency: "USD",
            condition: "nm",
            sourceRecordId: "tenant_hack",
            fingerprint: "fp_tenant_hack",
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await adminConn.end();
    }
  });

  it("prevents tenants from mutating global source intelligence facts", async () => {
    const adminConn = createDbConnection(adminUrl);
    try {
      const ingested = await withPlatformContext(adminConn.db, (db) =>
        ingestSourceContentRecord(db, {
          provider: "youtube",
          provider_record_id: `iso_yt_${crypto.randomUUID()}`,
          event_type: "source.content.ingested",
          account: { external_account_id: "yt_iso", handle: "iso" },
          content: {
            external_content_id: `iso_vid_${crypto.randomUUID()}`,
            content_type: "video",
            published_at: "2026-01-01T00:00:00.000Z",
            canonical_url: "https://youtube.com/watch?v=iso",
            language: "en",
            excerpt: "Greninja 214",
          },
        }),
      );
      expect(ingested.status).toBe("processed");
      const raw = postgres(replaceConnectionRole(adminUrl, DB_ROLES.user, passwords.user), {
        max: 1,
        prepare: false,
      });
      try {
        const rows = await raw`select id from source_content where id = ${ingested.contentId}`;
        expect(rows).toHaveLength(1);
        await expect(
          raw`insert into source_content (
            id, source_type, external_content_id, account_id, published_at, canonical_url, content_type, fingerprint
          ) values ('sct_hack', 'youtube', 'hack', 'missing', now(), 'https://example.com', 'video', 'fp')`,
        ).rejects.toThrow();
        await expect(
          raw`update source_content set title = 'Hacked' where id = ${ingested.contentId}`,
        ).rejects.toThrow();
        await expect(raw`delete from source_content where id = ${ingested.contentId}`).rejects.toThrow();
      } finally {
        await raw.end({ timeout: 5 });
      }
      await expect(
        asUser(ids.userA, ids.orgA, (db) =>
          db.insert(sourceContent).values({
            id: "sct_tenant_hack",
            sourceType: "youtube",
            externalContentId: "tenant_hack",
            accountId: "missing",
            publishedAt: new Date(),
            canonicalUrl: "https://example.com",
            contentType: "video",
            fingerprint: "fp",
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await adminConn.end();
    }
  });

  it("prevents tenants from mutating global entity resolution history", async () => {
    const adminConn = createDbConnection(adminUrl);
    try {
      const resolved = await withPlatformContext(adminConn.db, async (db) => {
        await seedTcgIdentityFixtures(db);
        return resolveEntity(db, {
          subjectType: "manual",
          subjectId: `iso_res_${crypto.randomUUID()}`,
          signals: {
            game: "pokemon",
            set: "twm",
            collector_number: "214/167",
            language: "en",
            variant: "normal",
          },
        });
      });
      expect(resolved.attempt.status).toBe("exact");
      const raw = postgres(replaceConnectionRole(adminUrl, DB_ROLES.user, passwords.user), {
        max: 1,
        prepare: false,
      });
      try {
        const rows = await raw`select id from entity_resolution_attempt where id = ${resolved.attempt.id}`;
        expect(rows).toHaveLength(1);
        await expect(
          raw`insert into entity_resolution_attempt (
            id, subject_type, subject_id, target_layer, status, resolver_version, input_signals
          ) values ('era_hack', 'manual', 'hack', 'printing', 'unresolved', 'resolver.v1', '{}'::jsonb)`,
        ).rejects.toThrow();
        await expect(
          raw`update entity_resolution_attempt set status = 'exact' where id = ${resolved.attempt.id}`,
        ).rejects.toThrow();
        await expect(
          raw`delete from entity_resolution_attempt where id = ${resolved.attempt.id}`,
        ).rejects.toThrow();
      } finally {
        await raw.end({ timeout: 5 });
      }
      await expect(
        asUser(ids.userA, ids.orgA, (db) =>
          db.insert(entityResolutionAttempt).values({
            id: "era_tenant_hack",
            subjectType: "manual",
            subjectId: "tenant_hack",
            targetLayer: "printing",
            status: "unresolved",
            resolverVersion: "resolver.v1",
            inputSignals: {},
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await adminConn.end();
    }
  });

  it("prevents tenants from mutating global creator calls", async () => {
    const adminConn = createDbConnection(adminUrl);
    try {
      const extracted = await withPlatformContext(adminConn.db, async (db) => {
        await seedTcgIdentityFixtures(db);
        const ingested = await ingestSourceContentRecord(db, creatorCallSourceFixtures()[0]!);
        return extractCreatorCallsFromContent(db, ingested.contentId!);
      });
      const callId = extracted[0]?.call?.id;
      expect(callId).toBeTruthy();
      const raw = postgres(replaceConnectionRole(adminUrl, DB_ROLES.user, passwords.user), {
        max: 1,
        prepare: false,
      });
      try {
        const rows = await raw`select id from creator_call where id = ${callId}`;
        expect(rows).toHaveLength(1);
        await expect(
          raw`insert into creator_call (
            id, creator_id, source_account_id, content_id, published_at, resolution_status,
            direction, extraction_confidence, extraction_version, fingerprint
          ) values ('cc_hack', 'missing', 'missing', 'missing', now(), 'unresolved', 'bullish', 0.1, 'v', 'fp')`,
        ).rejects.toThrow();
        await expect(raw`update creator_call set direction = 'bearish' where id = ${callId}`).rejects.toThrow();
        await expect(raw`delete from creator_call where id = ${callId}`).rejects.toThrow();
      } finally {
        await raw.end({ timeout: 5 });
      }
      await expect(
        asUser(ids.userA, ids.orgA, (db) =>
          db.insert(creatorCall).values({
            id: "cc_tenant_hack",
            creatorId: "missing",
            sourceAccountId: "missing",
            contentId: "missing",
            publishedAt: new Date(),
            resolutionStatus: "unresolved",
            direction: "bullish",
            extractionConfidence: "0.1",
            extractionVersion: "v",
            fingerprint: "tenant_hack",
          }),
        ),
      ).rejects.toThrow();
      await expect(
        asUser(ids.userA, ids.orgA, (db) =>
          db.insert(creatorAuthoritySlice).values({
            id: "cas_tenant_hack",
            creatorId: "missing",
            sampleSize: "0",
            successes: "0",
            trustState: "low_confidence",
            formulaVersion: "authority.v1",
            benchmarkRequirement: "phase_13_language_era_set_tier_index",
            components: {},
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await adminConn.end();
    }
  });

  it("prevents tenants from mutating global analytics, indices, and alpha", async () => {
    const adminConn = createDbConnection(adminUrl);
    try {
      const snapshotId = await withPlatformContext(adminConn.db, async (db) => {
        const seeded = await seedTcgIdentityFixtures(db);
        await ingestTcgMarketRecord(db, {
          provider: "fixture",
          provider_record_id: `iso_feat_${crypto.randomUUID()}`,
          event_type: "tcg.market.sold",
          market_type: "marketplace_sold",
          price_type: "sold",
          observed_at: "2026-01-01T00:00:00.000Z",
          currency: "USD",
          condition: "nm",
          price: 40,
          printing: {
            game: "pokemon",
            set: "twm",
            collector_number: "214/167",
            language: "en",
            variant: "normal",
          },
        });
        const computed = await computeMarketFeatures(db, {
          printingId: seeded.printings.greninjaEnNormal.id,
          asOf: new Date("2026-01-01T00:00:00.000Z"),
        });
        const persisted = await persistMarketFeatureSnapshot(db, computed);
        return persisted.id;
      });
      const raw = postgres(replaceConnectionRole(adminUrl, DB_ROLES.user, passwords.user), {
        max: 1,
        prepare: false,
      });
      try {
        const rows = await raw`select id from tcg_market_feature_snapshot where id = ${snapshotId}`;
        expect(rows).toHaveLength(1);
        await expect(
          raw`insert into tcg_market_feature_snapshot (
            id, printing_id, as_of, feature_set_key, feature_set_version, language_code, currency, outlier_policy, features, data_quality, sample_size
          ) values ('feat_hack', 'missing', now(), 'tcg.market.features', 'features.v1', 'en', 'USD', 'exclude_flagged.v1', '{}'::jsonb, 'partial', 0)`,
        ).rejects.toThrow();
        await expect(
          raw`update tcg_market_feature_snapshot set data_quality = 'stale' where id = ${snapshotId}`,
        ).rejects.toThrow();
        await expect(raw`delete from tcg_market_feature_snapshot where id = ${snapshotId}`).rejects.toThrow();
      } finally {
        await raw.end({ timeout: 5 });
      }
      await expect(
        asUser(ids.userA, ids.orgA, (db) =>
          db.insert(tcgMarketFeatureSnapshot).values({
            id: "feat_tenant_hack",
            printingId: "missing",
            asOf: new Date(),
            featureSetKey: "tcg.market.features",
            featureSetVersion: "features.v1",
            languageCode: "en",
            currency: "USD",
            outlierPolicy: "exclude_flagged.v1",
            features: {},
            dataQuality: "partial",
            sampleSize: 0,
            sourceComposition: {},
          }),
        ),
      ).rejects.toThrow();
      await expect(
        asUser(ids.userA, ids.orgA, (db) =>
          db.insert(tcgScoreSnapshot).values({
            id: "score_tenant_hack",
            printingId: "missing",
            asOf: new Date(),
            scoreVersion: "score.v1",
            policyKey: "tcg.opportunity",
            policyVersion: "score.v1",
            recommendationVersion: "recommendation.v1",
            opportunityScore: "50",
            riskScore: "50",
            confidenceScore: "50",
            liquidityScore: "50",
            recommendation: "watch",
            dataQuality: "partial",
            languageCode: "en",
            components: {},
            explanations: [],
          }),
        ),
      ).rejects.toThrow();
      await expect(
        asUser(ids.userA, ids.orgA, (db) =>
          db.insert(tcgPrediction).values({
            id: "pred_tenant_hack",
            printingId: "missing",
            issuedAt: new Date(),
            dataCutoffAt: new Date(),
            horizon: "7d",
            modelKey: "stats.baseline",
            modelVersion: "stats.baseline.v1",
            visibility: "shadow",
            status: "issued",
            languageCode: "en",
            dataQuality: "partial",
            components: {},
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await adminConn.end();
    }
  });

  it("prevents tenants from hopping webhook endpoints", async () => {
    await asUser(ids.userA, ids.orgA, (db) =>
      db.insert(webhookEndpoint).values({
        id: "wh_a",
        organizationId: ids.orgA,
        url: "https://example.com/a",
        secretCiphertext: "cipher",
        secretHash: "hash",
        eventTypes: ["usage.warning"],
      }),
    );
    const visible = await asUser(ids.userB, ids.orgB, (db) => db.select().from(webhookEndpoint));
    expect(visible).toEqual([]);
    await expect(
      asUser(ids.userB, ids.orgB, (db) =>
        db.insert(webhookEndpoint).values({
          id: "wh_hop",
          organizationId: ids.orgA,
          url: "https://example.com/hop",
          secretCiphertext: "cipher",
          secretHash: "hash",
          eventTypes: ["usage.warning"],
        }),
      ),
    ).rejects.toThrow();
  });
});
