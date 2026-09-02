import type { Database } from "../client.js";
import { assertTenantContext } from "../rls.js";
import { enqueueWebhookDelivery } from "../webhooks/persist.js";
import type { WebhookEventType } from "../webhooks/catalog.js";
import { isAlertRuleType, type AlertRuleType, type NotificationCategory } from "./catalog.js";
import { insertEmailDelivery } from "./delivery.js";
import { createInAppNotification } from "./inbox.js";
import { isChannelOptedIn } from "./preferences.js";

export type AlertEvaluationSnapshot = {
  opportunityScore?: number;
  recommendation?: string | null;
  previousRecommendation?: string | null;
  priceMovePercent?: number;
  creatorCallDetected?: boolean;
  creatorConsensusChanged?: boolean;
  predictionCreated?: boolean;
  usagePercent?: number;
  webhookFailed?: boolean;
};

export type AlertDispatchEntitlements = {
  alerts: boolean;
  predictions: boolean;
};

export type AlertRuleMatchInput = {
  ruleType: string;
  enabled: boolean;
  config: Record<string, unknown>;
  snapshot: AlertEvaluationSnapshot;
  entitlements: AlertDispatchEntitlements;
};

export function canDispatchPredictionAlert(entitlements: AlertDispatchEntitlements): boolean {
  return entitlements.alerts && entitlements.predictions;
}

export function alertRuleMatches(input: AlertRuleMatchInput): boolean {
  if (!input.enabled || !input.entitlements.alerts) {
    return false;
  }
  if (!isAlertRuleType(input.ruleType)) {
    return false;
  }
  const type = input.ruleType as AlertRuleType;
  if (type === "prediction_created") {
    return canDispatchPredictionAlert(input.entitlements) && Boolean(input.snapshot.predictionCreated);
  }
  if (type === "opportunity_score_threshold") {
    return (
      typeof input.snapshot.opportunityScore === "number" &&
      typeof input.config.threshold === "number" &&
      input.snapshot.opportunityScore >= input.config.threshold
    );
  }
  if (type === "recommendation_change") {
    return Boolean(
      input.snapshot.recommendation &&
        input.snapshot.previousRecommendation &&
        input.snapshot.recommendation !== input.snapshot.previousRecommendation,
    );
  }
  if (type === "price_move") {
    return (
      typeof input.snapshot.priceMovePercent === "number" &&
      typeof input.config.percent === "number" &&
      Math.abs(input.snapshot.priceMovePercent) >= input.config.percent
    );
  }
  if (type === "creator_call") {
    return Boolean(input.snapshot.creatorCallDetected);
  }
  if (type === "creator_consensus") {
    return Boolean(input.snapshot.creatorConsensusChanged);
  }
  if (type === "usage_threshold") {
    return (
      typeof input.snapshot.usagePercent === "number" &&
      typeof input.config.percent === "number" &&
      input.snapshot.usagePercent >= input.config.percent
    );
  }
  if (type === "webhook_failure") {
    return Boolean(input.snapshot.webhookFailed);
  }
  return false;
}

function webhookEventFor(ruleType: AlertRuleType): WebhookEventType {
  if (ruleType === "creator_call") {
    return "creator.call_detected";
  }
  if (ruleType === "creator_consensus") {
    return "creator.consensus_changed";
  }
  if (ruleType === "usage_threshold") {
    return "usage.warning";
  }
  return "opportunity.changed";
}

function categoryForRule(ruleType: AlertRuleType): NotificationCategory {
  if (ruleType === "prediction_created") {
    return "prediction";
  }
  if (ruleType === "creator_call" || ruleType === "creator_consensus") {
    return "creator_alert";
  }
  if (ruleType === "usage_threshold") {
    return "usage";
  }
  if (ruleType === "webhook_failure") {
    return "account";
  }
  return "opportunity";
}

function copyForRule(ruleType: AlertRuleType, snapshot: AlertEvaluationSnapshot): { title: string; body: string } {
  if (ruleType === "prediction_created") {
    return {
      title: "Shadow prediction recorded",
      body: "A shadow prediction was stored for internal evaluation. It is not a customer publication.",
    };
  }
  if (ruleType === "opportunity_score_threshold") {
    return {
      title: "Opportunity threshold reached",
      body: `Opportunity score ${snapshot.opportunityScore ?? "n/a"} crossed the configured threshold.`,
    };
  }
  if (ruleType === "recommendation_change") {
    return {
      title: "Recommendation changed",
      body: `Recommendation moved from ${snapshot.previousRecommendation} to ${snapshot.recommendation}.`,
    };
  }
  if (ruleType === "price_move") {
    return {
      title: "Price move alert",
      body: `Observed move ${snapshot.priceMovePercent}% against the configured threshold.`,
    };
  }
  if (ruleType === "creator_call") {
    return { title: "Creator call detected", body: "A new creator call matched an enabled alert rule." };
  }
  if (ruleType === "creator_consensus") {
    return { title: "Creator consensus changed", body: "Creator consensus changed for a watched printing." };
  }
  if (ruleType === "usage_threshold") {
    return {
      title: "Usage threshold reached",
      body: `Usage is at ${snapshot.usagePercent}% of the current plan limit.`,
    };
  }
  return { title: "Webhook delivery failed", body: "A customer webhook delivery failed and needs operator review." };
}

export async function dispatchMatchingAlerts(
  scoped: Database,
  input: {
    organizationId: string;
    userId: string;
    rules: Array<{
      id: string;
      ruleType: string;
      enabled: boolean;
      config: Record<string, unknown>;
      channelPreference: string;
    }>;
    snapshot: AlertEvaluationSnapshot;
    entitlements: AlertDispatchEntitlements;
    webhookEndpointId?: string | null;
  },
): Promise<{ matched: number; delivered: number; suppressed: number }> {
  await assertTenantContext(scoped);
  let matched = 0;
  let delivered = 0;
  let suppressed = 0;
  for (const rule of input.rules) {
    if (
      !alertRuleMatches({
        ruleType: rule.ruleType,
        enabled: rule.enabled,
        config: rule.config,
        snapshot: input.snapshot,
        entitlements: input.entitlements,
      })
    ) {
      continue;
    }
    matched += 1;
    if (!isAlertRuleType(rule.ruleType)) {
      suppressed += 1;
      continue;
    }
    const category = categoryForRule(rule.ruleType);
    const copy = copyForRule(rule.ruleType, input.snapshot);
    const channel = rule.channelPreference;
    if (channel === "in_app" || channel === "email") {
      const optedIn = await isChannelOptedIn(scoped, {
        organizationId: input.organizationId,
        userId: input.userId,
        category,
        channel,
      });
      if (!optedIn) {
        suppressed += 1;
        continue;
      }
    }
    if (channel === "in_app") {
      await createInAppNotification(scoped, {
        organizationId: input.organizationId,
        userId: input.userId,
        type: `alert.${rule.ruleType}`,
        title: copy.title,
        body: copy.body,
        severity: rule.ruleType === "prediction_created" ? "info" : "warning",
        referenceType: "alert_rule",
        referenceId: rule.id,
      });
      delivered += 1;
      continue;
    }
    if (channel === "email") {
      await insertEmailDelivery(scoped, {
        organizationId: input.organizationId,
        userId: input.userId,
        templateKey: `alert.${rule.ruleType}`,
        templateVersion: "v1",
        provider: "mock",
        status: "queued",
      });
      delivered += 1;
      continue;
    }
    if (channel === "webhook") {
      if (!input.webhookEndpointId) {
        suppressed += 1;
        continue;
      }
      await enqueueWebhookDelivery(scoped, {
        organizationId: input.organizationId,
        endpointId: input.webhookEndpointId,
        eventId: `alert:${rule.id}:${rule.ruleType}`,
        eventType: webhookEventFor(rule.ruleType),
        payload: { rule_id: rule.id, rule_type: rule.ruleType, customer_visible: false },
      });
      delivered += 1;
      continue;
    }
    suppressed += 1;
  }
  return { matched, delivered, suppressed };
}
