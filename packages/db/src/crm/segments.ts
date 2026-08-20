import { eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { crmOrganizationProfile, crmSegmentDefinition, crmSegmentMembership } from "../schema/crm.js";
import { SEGMENT_RULE_VERSION } from "./catalog.js";
import type { LifecycleStage } from "./catalog.js";

export type SegmentPredicate =
  | { field: "lifecycle_stage"; op: "eq" | "neq"; value: LifecycleStage }
  | { field: "customer_status"; op: "eq" | "neq"; value: string }
  | { field: "industry"; op: "eq"; value: string };

export type SegmentRules = {
  version: typeof SEGMENT_RULE_VERSION;
  all: SegmentPredicate[];
};

export function parseSegmentRules(raw: Record<string, unknown>): SegmentRules | null {
  if (raw.version !== SEGMENT_RULE_VERSION || !Array.isArray(raw.all)) {
    return null;
  }
  const all: SegmentPredicate[] = [];
  for (const item of raw.all) {
    if (!item || typeof item !== "object") {
      return null;
    }
    const row = item as Record<string, unknown>;
    if (row.field === "lifecycle_stage" && (row.op === "eq" || row.op === "neq") && typeof row.value === "string") {
      all.push({ field: "lifecycle_stage", op: row.op, value: row.value as LifecycleStage });
      continue;
    }
    if (row.field === "customer_status" && (row.op === "eq" || row.op === "neq") && typeof row.value === "string") {
      all.push({ field: "customer_status", op: row.op, value: row.value });
      continue;
    }
    if (row.field === "industry" && row.op === "eq" && typeof row.value === "string") {
      all.push({ field: "industry", op: "eq", value: row.value });
      continue;
    }
    return null;
  }
  return { version: SEGMENT_RULE_VERSION, all };
}

function matchesPredicate(
  profile: {
    lifecycleStage: string;
    customerStatus: string;
    industry: string | null;
  },
  predicate: SegmentPredicate,
): boolean {
  if (predicate.field === "lifecycle_stage") {
    return predicate.op === "eq"
      ? profile.lifecycleStage === predicate.value
      : profile.lifecycleStage !== predicate.value;
  }
  if (predicate.field === "customer_status") {
    return predicate.op === "eq"
      ? profile.customerStatus === predicate.value
      : profile.customerStatus !== predicate.value;
  }
  return (profile.industry ?? "") === predicate.value;
}

export function profileMatchesSegment(
  profile: {
    lifecycleStage: string;
    customerStatus: string;
    industry: string | null;
  },
  rules: SegmentRules,
): boolean {
  return rules.all.every((predicate) => matchesPredicate(profile, predicate));
}

export async function insertSegmentDefinition(
  db: Database,
  input: { key: string; rules: SegmentRules },
) {
  const [row] = await db
    .insert(crmSegmentDefinition)
    .values({
      id: crypto.randomUUID(),
      key: input.key,
      version: input.rules.version,
      rules: input.rules,
    })
    .returning();
  return row!;
}

export async function evaluateSegmentMembership(db: Database, segmentId: string) {
  const [segment] = await db
    .select()
    .from(crmSegmentDefinition)
    .where(eq(crmSegmentDefinition.id, segmentId))
    .limit(1);
  if (!segment) {
    return [];
  }
  const rules = parseSegmentRules(segment.rules);
  if (!rules) {
    return [];
  }
  const profiles = await db.select().from(crmOrganizationProfile);
  const matches = profiles.filter((profile) =>
    profileMatchesSegment(
      {
        lifecycleStage: profile.lifecycleStage,
        customerStatus: profile.customerStatus,
        industry: profile.industry,
      },
      rules,
    ),
  );
  for (const profile of matches) {
    await db
      .insert(crmSegmentMembership)
      .values({
        organizationId: profile.organizationId,
        segmentId,
        evaluatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [crmSegmentMembership.organizationId, crmSegmentMembership.segmentId],
        set: { evaluatedAt: new Date() },
      });
  }
  return matches.map((row) => row.organizationId);
}
