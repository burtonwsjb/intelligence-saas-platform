import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../client.js";
import { crmCustomerEvent } from "../schema/crm.js";
import { ACTIVATION_RULE_VERSION, type ActivationCriterion } from "./catalog.js";

export type ActivationEvidence = Record<ActivationCriterion, boolean>;

export type ActivationEvaluation = {
  version: typeof ACTIVATION_RULE_VERSION;
  activated: boolean;
  evidence: ActivationEvidence;
};

const FIRST_EVENT_TYPES = [
  "api_key.created",
  "first_event.ingested",
  "first_opportunity.viewed",
  "webhook.created",
] as const;

/**
 * activation.v1: organization created plus any one product-use signal.
 * Product-use signals: first API key, first ingested event, first intelligence
 * view, or first webhook. None of those is sufficient alone without an org.
 */
export function evaluateActivationV1(evidence: ActivationEvidence): boolean {
  if (!evidence.organization_created) {
    return false;
  }
  return (
    evidence.first_api_key ||
    evidence.first_event_ingested ||
    evidence.first_intelligence_viewed ||
    evidence.first_webhook_configured
  );
}

export async function collectActivationEvidence(
  scoped: Database,
  organizationId: string,
): Promise<ActivationEvidence> {
  const rows = await scoped
    .select({ eventType: crmCustomerEvent.eventType })
    .from(crmCustomerEvent)
    .where(
      and(
        eq(crmCustomerEvent.organizationId, organizationId),
        inArray(crmCustomerEvent.eventType, ["organization.created", ...FIRST_EVENT_TYPES]),
      ),
    );
  const types = new Set(rows.map((row) => row.eventType));
  return {
    organization_created: types.has("organization.created"),
    first_api_key: types.has("api_key.created"),
    first_event_ingested: types.has("first_event.ingested"),
    first_intelligence_viewed: types.has("first_opportunity.viewed"),
    first_webhook_configured: types.has("webhook.created"),
  };
}

export async function evaluateActivation(
  scoped: Database,
  organizationId: string,
): Promise<ActivationEvaluation> {
  const evidence = await collectActivationEvidence(scoped, organizationId);
  return {
    version: ACTIVATION_RULE_VERSION,
    activated: evaluateActivationV1(evidence),
    evidence,
  };
}
