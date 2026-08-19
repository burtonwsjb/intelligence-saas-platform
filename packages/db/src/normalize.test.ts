import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  getObservationBySourceEvent,
  insertEntity,
  insertEntityIdentifier,
  insertSourceEvent,
  listDecisionEvidence,
  listObservationMetrics,
  listObservationsInRange,
  listSignalEvidence,
  listSignalsInRange,
  finalizeDecisionRecord,
  insertDecisionEvidence,
  insertDecisionRecord,
  member,
  organization,
  readMigrationSql,
  tenant,
  user,
  withOrganizationContext,
  IdentifierCollisionError,
  InvalidConfidenceError,
  InvalidMetricError,
  MissingSignalEvidenceError,
  UnknownEventTypeError,
  normalizeSourceEvent,
  parseConfidence,
  requireSignalEvidence,
  type Database,
} from "./index.js";

async function seed(db: Database) {
  await db.insert(user).values({
    id: "user_k",
    name: "K",
    email: "k@example.com",
    emailVerified: true,
  });
  await db.insert(organization).values({ id: "org_k", name: "K", slug: "org-k" });
  await db.insert(member).values({
    id: "mem_k",
    organizationId: "org_k",
    userId: "user_k",
    role: "owner",
  });
  await db.insert(tenant).values({
    organizationId: "org_k",
    status: "active",
    createdByUserId: "user_k",
  });
}

describe("normalizeSourceEvent", () => {
  it("creates entity, observation, metrics, evidence, and signal idempotently", async () => {
    const client = new PGlite();
    await client.exec(await readMigrationSql());
    const db = drizzle(client) as unknown as Database;
    await seed(db);

    const occurred = new Date("2026-01-01T00:00:00.000Z");
    const received = new Date("2026-01-02T00:00:00.000Z");
    const eventId = crypto.randomUUID();
    await withOrganizationContext(db, { organizationId: "org_k", userId: "user_k" }, async (scoped) => {
      await insertSourceEvent(scoped, {
        id: eventId,
        organizationId: "org_k",
        eventType: "pricing.snapshot",
        occurredAt: occurred,
        idempotencyKey: `idem_${eventId}`,
        fingerprint: "fp",
        entity: { type: "sku", external_id: "SKU-123", display_name: "Widget" },
        metrics: [{ key: "price.usd", value: 12.5, unit: "usd" }],
        payload: { source: "generic_http" },
      });
      const first = await normalizeSourceEvent(scoped, {
        id: eventId,
        organizationId: "org_k",
        eventType: "pricing.snapshot",
        occurredAt: occurred,
        receivedAt: received,
        entity: { type: "sku", external_id: "SKU-123", display_name: "Widget" },
        metrics: [{ key: "price.usd", value: 12.5, unit: "usd" }],
        payload: { source: "generic_http" },
      });
      const replay = await normalizeSourceEvent(scoped, {
        id: eventId,
        organizationId: "org_k",
        eventType: "pricing.snapshot",
        occurredAt: occurred,
        receivedAt: received,
        entity: { type: "sku", external_id: "SKU-123" },
        metrics: [{ key: "price.usd", value: 12.5, unit: "usd" }],
        payload: {},
      });
      expect(first.status).toBe("normalized");
      expect(replay.status).toBe("duplicate");
      expect(replay.observationId).toBe(first.observationId);

      const observation = await getObservationBySourceEvent(scoped, {
        organizationId: "org_k",
        sourceEventId: eventId,
      });
      expect(observation?.observedAt.toISOString()).toBe(occurred.toISOString());
      expect(observation?.receivedAt.toISOString()).toBe(received.toISOString());
      expect(observation?.observationType).toBe("metric.snapshot");
      const metrics = await listObservationMetrics(scoped, {
        organizationId: "org_k",
        observationId: observation!.id,
      });
      expect(metrics).toHaveLength(1);
      expect(Number(metrics[0]?.numericValue)).toBe(12.5);
      const history = await listObservationsInRange(scoped, {
        organizationId: "org_k",
        from: new Date("2025-12-01T00:00:00.000Z"),
        to: new Date("2026-02-01T00:00:00.000Z"),
      });
      expect(history.map((row) => row.id)).toEqual([observation!.id]);
      const signals = await listSignalsInRange(scoped, {
        organizationId: "org_k",
        from: occurred,
        to: occurred,
      });
      expect(signals).toHaveLength(1);
      const evidence = await listSignalEvidence(scoped, {
        organizationId: "org_k",
        signalId: signals[0]!.id,
      });
      expect(evidence).toHaveLength(1);

      const decision = await insertDecisionRecord(scoped, {
        id: crypto.randomUUID(),
        organizationId: "org_k",
        entityId: first.entityId,
        decisionType: "review.flag",
        confidence: "0.5000",
        policyKey: "kernel.placeholder",
        policyVersion: "1",
        featureSnapshotId: signals[0]!.featureSnapshotId,
        result: { note: "foundation only" },
      });
      await insertDecisionEvidence(scoped, {
        id: crypto.randomUUID(),
        organizationId: "org_k",
        decisionId: decision!.id,
        signalId: signals[0]!.id,
        role: "cited",
      });
      await finalizeDecisionRecord(scoped, { organizationId: "org_k", id: decision!.id });
      const cited = await listDecisionEvidence(scoped, {
        organizationId: "org_k",
        decisionId: decision!.id,
      });
      expect(cited).toHaveLength(1);

      const laterId = crypto.randomUUID();
      const laterOccurred = new Date("2026-03-01T00:00:00.000Z");
      await insertSourceEvent(scoped, {
        id: laterId,
        organizationId: "org_k",
        eventType: "pricing.snapshot",
        occurredAt: laterOccurred,
        idempotencyKey: `idem_${laterId}`,
        fingerprint: "fp2",
        entity: { type: "sku", external_id: "SKU-123" },
        metrics: [{ key: "price.usd", value: 13, unit: "usd" }],
        payload: {},
      });
      await normalizeSourceEvent(scoped, {
        id: laterId,
        organizationId: "org_k",
        eventType: "pricing.snapshot",
        occurredAt: laterOccurred,
        receivedAt: laterOccurred,
        entity: { type: "sku", external_id: "SKU-123" },
        metrics: [{ key: "price.usd", value: 13, unit: "usd" }],
        payload: {},
      });
      const ordered = await listObservationsInRange(scoped, {
        organizationId: "org_k",
        entityId: first.entityId,
        from: new Date("2025-12-01T00:00:00.000Z"),
        to: new Date("2026-04-01T00:00:00.000Z"),
      });
      expect(ordered.map((row) => row.id)).toEqual([eventId, laterId]);
    });
  });

  it("rejects unknown event types, invalid metrics, confidence bounds, and identifier collisions", async () => {
    expect(() => parseConfidence(-0.1)).toThrow();
    expect(() => parseConfidence(1.1)).toThrow();
    expect(() => requireSignalEvidence(0)).toThrow(MissingSignalEvidenceError);
    requireSignalEvidence(1);
    const client = new PGlite();
    await client.exec(await readMigrationSql());
    const db = drizzle(client) as unknown as Database;
    await seed(db);
    await withOrganizationContext(db, { organizationId: "org_k", userId: "user_k" }, async (scoped) => {
      await expect(
        normalizeSourceEvent(scoped, {
          id: crypto.randomUUID(),
          organizationId: "org_k",
          eventType: "unknown.event",
          occurredAt: new Date(),
          receivedAt: new Date(),
          entity: { type: "sku", external_id: "x" },
          metrics: [],
          payload: {},
        }),
      ).rejects.toBeInstanceOf(UnknownEventTypeError);
      await expect(
        normalizeSourceEvent(scoped, {
          id: crypto.randomUUID(),
          organizationId: "org_k",
          eventType: "metric.snapshot",
          occurredAt: new Date(),
          receivedAt: new Date(),
          entity: { type: "sku", external_id: "x" },
          metrics: [{ key: "BAD", value: 1 }],
          payload: {},
        }),
      ).rejects.toBeInstanceOf(InvalidMetricError);
      await expect(
        normalizeSourceEvent(scoped, {
          id: crypto.randomUUID(),
          organizationId: "org_k",
          eventType: "metric.snapshot",
          occurredAt: new Date(),
          receivedAt: new Date(),
          entity: { type: "sku", external_id: "x", confidence: -0.01 },
          metrics: [{ key: "price.usd", value: 1 }],
          payload: {},
        }),
      ).rejects.toBeInstanceOf(InvalidConfidenceError);
      await expect(
        normalizeSourceEvent(scoped, {
          id: crypto.randomUUID(),
          organizationId: "org_k",
          eventType: "metric.snapshot",
          occurredAt: new Date(),
          receivedAt: new Date(),
          entity: { type: "sku", external_id: "x", confidence: 1.5 },
          metrics: [{ key: "price.usd", value: 1 }],
          payload: {},
        }),
      ).rejects.toBeInstanceOf(InvalidConfidenceError);

      const first = await insertEntity(scoped, {
        id: "ent_one_collision_test_0001",
        organizationId: "org_k",
        entityType: "sku",
        canonicalKey: "sku:ingest:sku:other",
      });
      const second = await insertEntity(scoped, {
        id: "ent_two_collision_test_0002",
        organizationId: "org_k",
        entityType: "sku",
        canonicalKey: "sku:ingest:sku:another",
      });
      await insertEntityIdentifier(scoped, {
        id: "eid_collision_1",
        organizationId: "org_k",
        entityId: first!.id,
        sourceNamespace: "ingest",
        identifierType: "sku",
        identifierValue: "dup",
        normalizedValue: "dup",
      });
      await expect(
        insertEntityIdentifier(scoped, {
          id: "eid_collision_2",
          organizationId: "org_k",
          entityId: second!.id,
          sourceNamespace: "ingest",
          identifierType: "sku",
          identifierValue: "DUP",
          normalizedValue: "dup",
        }),
      ).rejects.toBeInstanceOf(IdentifierCollisionError);
    });
  });
});
