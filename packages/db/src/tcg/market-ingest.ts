import { and, desc, eq, isNull } from "drizzle-orm";
import {
  tcgMarketIngest,
  tcgMarketQuarantine,
  tcgMarketRevision,
  tcgMarketSnapshot,
} from "../schema/tcg-market.js";
import type { Database } from "../client.js";
import { TcgValidationError } from "./identity.js";
import { resolveTcgPrinting } from "./resolve.js";
import {
  defaultPriceType,
  flagOutlierV1,
  marketFingerprint,
  parsePositiveAmount,
  parseTcgMarketRecord,
  stableMarketId,
  TcgMarketRevisionError,
  TcgMarketValidationError,
  type TcgMarketRecordInput,
} from "./market-identity.js";

export type TcgMarketIngestResult = {
  status: "processed" | "duplicate" | "quarantined" | "conflict";
  snapshotId: string | null;
  quarantineId: string | null;
  ingestId: string;
};

function materialFingerprint(input: TcgMarketRecordInput) {
  return marketFingerprint({
    provider: input.provider,
    provider_record_id: input.provider_record_id,
    printing: input.printing ?? null,
    external_id: input.external_id ?? null,
    market_type: input.market_type,
    price_type: input.price_type ?? defaultPriceType(input.market_type),
    observed_at: input.observed_at,
    currency: input.currency,
    condition: input.condition,
    grading_company: input.grading_company ?? null,
    grade_label: input.grade_label ?? null,
    price: input.price ?? null,
    quantity: input.quantity ?? null,
    listing_count: input.listing_count ?? null,
    sales_count: input.sales_count ?? null,
    volume_value: input.volume_value ?? null,
    low_price: input.low_price ?? null,
    high_price: input.high_price ?? null,
    median_price: input.median_price ?? null,
    window_seconds: input.window_seconds ?? null,
    aggregation_kind: input.aggregation_kind ?? "event",
  });
}

async function insertQuarantine(
  db: Database,
  input: TcgMarketRecordInput,
  reason: string,
  fingerprint: string,
) {
  const id = stableMarketId("mqz", [input.provider, input.provider_record_id, fingerprint]);
  await db
    .insert(tcgMarketQuarantine)
    .values({
      id,
      sourceKey: input.provider,
      sourceRecordId: input.provider_record_id,
      reason,
      printingReference: (input.printing ?? input.external_id ?? {}) as Record<string, unknown>,
      payload: input as unknown as Record<string, unknown>,
      fingerprint,
      receivedAt: new Date(),
    })
    .onConflictDoNothing();
  return id;
}

export async function listRecentSoldPrices(
  db: Database,
  input: {
    printingId: string;
    condition: string;
    currency: string;
    gradingCompany: string | null;
    gradeLabel: string | null;
    limit?: number;
  },
) {
  const gradeClauses =
    input.gradingCompany == null
      ? [isNull(tcgMarketSnapshot.gradingCompany)]
      : [
          eq(tcgMarketSnapshot.gradingCompany, input.gradingCompany),
          ...(input.gradeLabel ? [eq(tcgMarketSnapshot.gradeLabel, input.gradeLabel)] : []),
        ];
  const rows = await db
    .select({ price: tcgMarketSnapshot.price })
    .from(tcgMarketSnapshot)
    .where(
      and(
        eq(tcgMarketSnapshot.printingId, input.printingId),
        eq(tcgMarketSnapshot.priceType, "sold"),
        eq(tcgMarketSnapshot.condition, input.condition),
        eq(tcgMarketSnapshot.currency, input.currency),
        ...gradeClauses,
      ),
    )
    .orderBy(desc(tcgMarketSnapshot.observedAt))
    .limit(input.limit ?? 7);
  return rows
    .map((row) => (row.price == null ? null : Number(row.price)))
    .filter((value): value is number => value != null && Number.isFinite(value));
}

export async function ingestTcgMarketRecord(
  db: Database,
  raw: TcgMarketRecordInput,
): Promise<TcgMarketIngestResult> {
  const input = parseTcgMarketRecord(raw);
  const ingestId = stableMarketId("min", [input.provider, input.provider_record_id]);
  const fingerprint = materialFingerprint(input);

  const [existingIngest] = await db
    .select()
    .from(tcgMarketIngest)
    .where(
      and(
        eq(tcgMarketIngest.sourceKey, input.provider),
        eq(tcgMarketIngest.sourceRecordId, input.provider_record_id),
      ),
    )
    .limit(1);

  if (existingIngest && existingIngest.fingerprint !== fingerprint && existingIngest.snapshotId) {
    await db.insert(tcgMarketRevision).values({
      id: crypto.randomUUID(),
      sourceKey: input.provider,
      sourceRecordId: input.provider_record_id,
      existingSnapshotId: existingIngest.snapshotId,
      existingFingerprint: existingIngest.fingerprint,
      attemptedFingerprint: fingerprint,
    });
    throw new TcgMarketRevisionError();
  }

  if (
    existingIngest &&
    existingIngest.fingerprint === fingerprint &&
    (existingIngest.processingStatus === "processed" || existingIngest.processingStatus === "quarantined")
  ) {
    return {
      status: existingIngest.processingStatus === "quarantined" ? "quarantined" : "duplicate",
      snapshotId: existingIngest.snapshotId,
      quarantineId: existingIngest.quarantineId,
      ingestId: existingIngest.id,
    };
  }

  await db
    .insert(tcgMarketIngest)
    .values({
      id: ingestId,
      sourceKey: input.provider,
      sourceRecordId: input.provider_record_id,
      eventType: input.event_type,
      fingerprint,
      payload: input as unknown as Record<string, unknown>,
      processingStatus: "received",
    })
    .onConflictDoNothing();

  const hasCorePrinting = Boolean(
    input.printing?.game && input.printing.set && input.printing.collector_number,
  );
  const hasLanguage = Boolean(input.printing?.language);
  if (!input.external_id && (!hasCorePrinting || !hasLanguage)) {
    const quarantineId = await insertQuarantine(db, input, "concept_only", fingerprint);
    await db
      .update(tcgMarketIngest)
      .set({ processingStatus: "quarantined", quarantineId, updatedAt: new Date() })
      .where(eq(tcgMarketIngest.id, ingestId));
    return { status: "quarantined", snapshotId: null, quarantineId, ingestId };
  }

  let resolved;
  try {
    resolved = await resolveTcgPrinting(db, {
      game: input.printing?.game,
      set: input.printing?.set,
      collector_number: input.printing?.collector_number,
      language: input.printing?.language,
      variant: input.printing?.variant,
      external_id: input.external_id,
    });
  } catch (error) {
    if (error instanceof TcgValidationError) {
      const reason = /language|variant/i.test(error.message) ? "concept_only" : "invalid_printing";
      const quarantineId = await insertQuarantine(db, input, reason, fingerprint);
      await db
        .update(tcgMarketIngest)
        .set({ processingStatus: "quarantined", quarantineId, updatedAt: new Date() })
        .where(eq(tcgMarketIngest.id, ingestId));
      return { status: "quarantined", snapshotId: null, quarantineId, ingestId };
    }
    throw error;
  }

  if (resolved.status !== "exact" || !resolved.printingId) {
    const reason =
      resolved.status === "ambiguous"
        ? "ambiguous"
        : resolved.status === "conflict"
          ? "conflict"
          : "not_found";
    const quarantineId = await insertQuarantine(db, input, reason, fingerprint);
    await db
      .update(tcgMarketIngest)
      .set({ processingStatus: "quarantined", quarantineId, updatedAt: new Date() })
      .where(eq(tcgMarketIngest.id, ingestId));
    return { status: "quarantined", snapshotId: null, quarantineId, ingestId };
  }

  const boundFingerprint = fingerprint;
  const snapshotId = stableMarketId("msn", [input.provider, input.provider_record_id]);
  const prior = await listRecentSoldPrices(db, {
    printingId: resolved.printingId,
    condition: input.condition,
    currency: input.currency,
    gradingCompany: input.grading_company ?? null,
    gradeLabel: input.grade_label ?? null,
  });
  const outlier = flagOutlierV1({
    price: input.price ?? input.low_price ?? null,
    priorPrices: prior,
    quantity: input.quantity ?? null,
  });
  const incomplete =
    input.market_type === "marketplace_listing" &&
    input.listing_count == null &&
    input.low_price == null &&
    input.price == null;
  const qualityLabel = outlier.outlier_flag ? "outlier" : incomplete ? "incomplete" : "normal";

  await db
    .insert(tcgMarketSnapshot)
    .values({
      id: snapshotId,
      printingId: resolved.printingId,
      sourceKey: input.provider,
      marketType: input.market_type,
      priceType: input.price_type ?? defaultPriceType(input.market_type),
      observedAt: new Date(input.observed_at),
      currency: input.currency,
      condition: input.condition,
      gradingCompany: input.grading_company ?? null,
      gradeLabel: input.grade_label ?? null,
      gradeNumeric: input.grade_numeric == null ? null : input.grade_numeric.toString(),
      certificationNumber: input.certification_number ?? null,
      price: parsePositiveAmount(input.price ?? null, "price"),
      quantity: input.quantity ?? null,
      listingCount: input.listing_count ?? null,
      salesCount: input.sales_count ?? null,
      volumeValue: parsePositiveAmount(input.volume_value ?? null, "volume_value"),
      lowPrice: parsePositiveAmount(input.low_price ?? null, "low_price"),
      highPrice: parsePositiveAmount(input.high_price ?? null, "high_price"),
      medianPrice: parsePositiveAmount(input.median_price ?? null, "median_price"),
      averagePrice: parsePositiveAmount(input.average_price ?? null, "average_price"),
      bidCount: input.bid_count ?? null,
      sellerCount: input.seller_count ?? null,
      shippingAmount: parsePositiveAmount(input.shipping_amount ?? null, "shipping_amount"),
      taxAmount: parsePositiveAmount(input.tax_amount ?? null, "tax_amount"),
      feeAmount: parsePositiveAmount(input.fee_amount ?? null, "fee_amount"),
      windowSeconds: input.window_seconds ?? null,
      aggregationKind: input.aggregation_kind ?? "event",
      sourceRecordId: input.provider_record_id,
      fingerprint: boundFingerprint,
      sourceReference: input.source_reference ?? null,
      qualityLabel,
      outlierFlag: outlier.outlier_flag,
      outlierReason: outlier.outlier_reason,
      outlierAlgorithmVersion: outlier.outlier_algorithm_version,
      attributes: {
        ...(input.attributes ?? {}),
        ...(input.raw_condition ? { raw_condition: input.raw_condition } : {}),
      },
    })
    .onConflictDoNothing();

  await db
    .update(tcgMarketIngest)
    .set({
      processingStatus: "processed",
      snapshotId,
      fingerprint: boundFingerprint,
      updatedAt: new Date(),
    })
    .where(eq(tcgMarketIngest.id, ingestId));

  return { status: "processed", snapshotId, quarantineId: null, ingestId };
}

export async function receiveTcgMarketRecord(
  db: Database,
  raw: TcgMarketRecordInput,
): Promise<{ ingestId: string }> {
  const input = parseTcgMarketRecord(raw);
  const ingestId = stableMarketId("min", [input.provider, input.provider_record_id]);
  await db
    .insert(tcgMarketIngest)
    .values({
      id: ingestId,
      sourceKey: input.provider,
      sourceRecordId: input.provider_record_id,
      eventType: input.event_type,
      fingerprint: materialFingerprint(input),
      payload: input as unknown as Record<string, unknown>,
      processingStatus: "received",
    })
    .onConflictDoNothing();
  return { ingestId };
}

export async function normalizeTcgMarketIngest(db: Database, ingestId: string) {
  const [row] = await db.select().from(tcgMarketIngest).where(eq(tcgMarketIngest.id, ingestId)).limit(1);
  if (!row) {
    throw new TcgMarketValidationError("Market ingest record is missing.");
  }
  if (row.processingStatus === "processed" || row.processingStatus === "quarantined") {
    return {
      status: row.processingStatus === "quarantined" ? ("quarantined" as const) : ("duplicate" as const),
      snapshotId: row.snapshotId,
      quarantineId: row.quarantineId,
      ingestId: row.id,
    };
  }
  return ingestTcgMarketRecord(db, row.payload as TcgMarketRecordInput);
}

export async function markTcgMarketIngestFailed(db: Database, ingestId: string) {
  await db
    .update(tcgMarketIngest)
    .set({ processingStatus: "failed", updatedAt: new Date() })
    .where(eq(tcgMarketIngest.id, ingestId));
}

export async function getTcgMarketSnapshot(db: Database, id: string) {
  const [row] = await db.select().from(tcgMarketSnapshot).where(eq(tcgMarketSnapshot.id, id)).limit(1);
  return row ?? null;
}

export async function listTcgMarketQuarantine(db: Database) {
  return db.select().from(tcgMarketQuarantine);
}

export async function listTcgMarketRevisions(db: Database) {
  return db.select().from(tcgMarketRevision);
}
