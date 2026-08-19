import { createHash } from "node:crypto";
import { tcgMarketSnapshot } from "../schema/tcg-market.js";
import { tcgPrinting } from "../schema/tcg.js";
import { eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { ensureTcgPrintingEntity } from "./kernel-link.js";
import {
  findSourceEventByIdempotency,
  insertSourceEvent,
  updateSourceEventStatus,
} from "../repos/source-event.js";
import { insertObservation, insertObservationMetric, getObservationBySourceEvent } from "../repos/observation.js";

type Snapshot = typeof tcgMarketSnapshot.$inferSelect;

function metricId(parts: string[]) {
  return `mtc_${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32)}`;
}

export async function projectTcgMarketSnapshotToTenant(
  scoped: Database,
  input: { organizationId: string; snapshot: Snapshot },
) {
  const [printing] = await scoped
    .select()
    .from(tcgPrinting)
    .where(eq(tcgPrinting.id, input.snapshot.printingId))
    .limit(1);
  if (!printing) {
    throw new Error("Exact printing is required for market projection.");
  }
  const entity = await ensureTcgPrintingEntity(scoped, {
    organizationId: input.organizationId,
    printing,
  });
  const idempotencyKey = `tcg.market.project:${input.snapshot.id}`;
  const existingEvent = await findSourceEventByIdempotency(scoped, {
    organizationId: input.organizationId,
    idempotencyKey,
  });
  const eventId =
    existingEvent?.id ??
    `sev_${createHash("sha256").update(`${input.organizationId}|${input.snapshot.id}`).digest("hex").slice(0, 32)}`;
  if (!existingEvent) {
    await insertSourceEvent(scoped, {
      id: eventId,
      organizationId: input.organizationId,
      eventType: eventTypeFor(input.snapshot),
      occurredAt: input.snapshot.observedAt,
      idempotencyKey,
      fingerprint: input.snapshot.fingerprint,
      entity: { type: "tcg_printing", external_id: printing.canonicalPrintingKey },
      metrics: [],
      payload: { snapshot_id: input.snapshot.id, source_key: input.snapshot.sourceKey },
    });
    await updateSourceEventStatus(scoped, {
      id: eventId,
      organizationId: input.organizationId,
      status: "processing",
    });
    await updateSourceEventStatus(scoped, {
      id: eventId,
      organizationId: input.organizationId,
      status: "processed",
    });
  }
  const existingObs = await getObservationBySourceEvent(scoped, {
    organizationId: input.organizationId,
    sourceEventId: eventId,
  });
  if (existingObs) {
    return { entity, observation: existingObs };
  }
  const observation = await insertObservation(scoped, {
    id: eventId,
    organizationId: input.organizationId,
    entityId: entity.id,
    sourceEventId: eventId,
    sourceNamespace: input.snapshot.sourceKey,
    observationType: eventTypeFor(input.snapshot),
    observedAt: input.snapshot.observedAt,
    receivedAt: input.snapshot.createdAt,
    qualityFlag: input.snapshot.outlierFlag ? "suspect" : "complete",
    attributes: {
      snapshot_id: input.snapshot.id,
      condition: input.snapshot.condition,
      currency: input.snapshot.currency,
      price_type: input.snapshot.priceType,
      grading_company: input.snapshot.gradingCompany,
      grade_label: input.snapshot.gradeLabel,
    },
  });
  const dimension = {
    source: input.snapshot.sourceKey,
    currency: input.snapshot.currency,
    condition: input.snapshot.condition,
    grade: input.snapshot.gradeLabel,
    grading_company: input.snapshot.gradingCompany,
  };
  const metrics: { key: string; value: string | null; unit?: string }[] = [];
  if (input.snapshot.priceType === "sold" && input.snapshot.price) {
    metrics.push({ key: "market.price.sold", value: input.snapshot.price, unit: input.snapshot.currency });
  }
  if (input.snapshot.priceType === "asking" && (input.snapshot.lowPrice || input.snapshot.price)) {
    metrics.push({
      key: "market.price.ask.low",
      value: input.snapshot.lowPrice ?? input.snapshot.price,
      unit: input.snapshot.currency,
    });
  }
  if (input.snapshot.priceType === "reference" && input.snapshot.price) {
    metrics.push({ key: "market.price.reference", value: input.snapshot.price, unit: input.snapshot.currency });
  }
  if (input.snapshot.listingCount != null) {
    metrics.push({ key: "market.listings.active", value: String(input.snapshot.listingCount) });
  }
  if (input.snapshot.salesCount != null) {
    metrics.push({ key: "market.sales.count", value: String(input.snapshot.salesCount) });
  }
  if (input.snapshot.volumeValue) {
    metrics.push({
      key: "market.volume.gross",
      value: input.snapshot.volumeValue,
      unit: input.snapshot.currency,
    });
  }
  for (const metric of metrics) {
    await insertObservationMetric(scoped, {
      id: metricId([input.organizationId, eventId, metric.key]),
      organizationId: input.organizationId,
      observationId: eventId,
      metricKey: metric.key,
      numericValue: metric.value,
      unit: metric.unit,
      dimension,
    });
  }
  return { entity, observation };
}

function eventTypeFor(snapshot: Snapshot): string {
  if (snapshot.marketType === "marketplace_sold" || snapshot.priceType === "sold") {
    return "tcg.market.sold";
  }
  if (snapshot.marketType === "marketplace_listing") {
    return "tcg.market.listing_snapshot";
  }
  if (snapshot.aggregationKind === "window") {
    return "tcg.market.volume_snapshot";
  }
  return "tcg.market.reference_price";
}
