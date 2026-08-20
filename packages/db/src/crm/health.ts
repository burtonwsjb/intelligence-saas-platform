import { and, eq, gte } from "drizzle-orm";
import type { Database } from "../client.js";
import { getMonthUsage, monthStartUtc } from "../repos/usage.js";
import { listWebhookEndpoints } from "../webhooks/persist.js";
import { crmCustomerEvent, crmOrganizationProfile } from "../schema/crm.js";
import { evaluateActivation } from "./activation.js";

export type CustomerHealthComponent = {
  key: string;
  score: number;
  reason: string;
};

export type CustomerHealth = {
  version: "health.v1";
  overall: number;
  components: CustomerHealthComponent[];
};

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export async function evaluateCustomerHealth(
  scoped: Database,
  input: {
    organizationId: string;
    billingStatus: string;
    apiLimit?: number;
    now?: Date;
  },
): Promise<CustomerHealth> {
  const now = input.now ?? new Date();
  const [profile] = await scoped
    .select()
    .from(crmOrganizationProfile)
    .where(eq(crmOrganizationProfile.organizationId, input.organizationId))
    .limit(1);
  const activation = await evaluateActivation(scoped, input.organizationId);
  const since = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const recentEvents = await scoped
    .select({ id: crmCustomerEvent.id })
    .from(crmCustomerEvent)
    .where(
      and(
        eq(crmCustomerEvent.organizationId, input.organizationId),
        gte(crmCustomerEvent.createdAt, since),
      ),
    );
  const usage = await getMonthUsage(scoped, {
    organizationId: input.organizationId,
    meterKey: "api.reads",
    at: now,
  });
  const endpoints = await listWebhookEndpoints(scoped, input.organizationId);
  const failing = endpoints.filter((row) => row.consecutiveFailures > 0 || row.status === "disabled");
  const adoptionTypes = await scoped
    .select({ eventType: crmCustomerEvent.eventType })
    .from(crmCustomerEvent)
    .where(eq(crmCustomerEvent.organizationId, input.organizationId));
  const types = new Set(adoptionTypes.map((row) => row.eventType));

  const components: CustomerHealthComponent[] = [
    {
      key: "activation",
      score: activation.activated ? 100 : activation.evidence.organization_created ? 40 : 0,
      reason: activation.activated
        ? `Activated under ${activation.version}`
        : "Product activation criteria are incomplete",
    },
    {
      key: "recent_activity",
      score: recentEvents.length === 0 ? 20 : Math.min(100, 40 + recentEvents.length * 15),
      reason:
        recentEvents.length === 0
          ? "No customer events in the last 14 days"
          : `${recentEvents.length} customer events in the last 14 days`,
    },
    {
      key: "api_usage",
      score: (() => {
        const limit = input.apiLimit ?? 0;
        if (!Number.isFinite(limit) || limit <= 0) {
          return usage > 0 ? 70 : 30;
        }
        const ratio = usage / limit;
        if (ratio === 0) {
          return 25;
        }
        if (ratio >= 1) {
          return 55;
        }
        return clamp(40 + ratio * 60);
      })(),
      reason: `Current period API reads: ${usage}`,
    },
    {
      key: "errors",
      score: types.has("payment_failed") ? 35 : 80,
      reason: types.has("payment_failed") ? "Payment failure recorded" : "No payment-failure customer events",
    },
    {
      key: "webhook_health",
      score: endpoints.length === 0 ? 60 : failing.length === 0 ? 100 : clamp(100 - failing.length * 25),
      reason:
        endpoints.length === 0
          ? "No webhooks configured"
          : failing.length === 0
            ? "Webhook endpoints are healthy"
            : `${failing.length} webhook endpoint(s) failing or disabled`,
    },
    {
      key: "billing_health",
      score:
        input.billingStatus === "active" || input.billingStatus === "trialing"
          ? 100
          : input.billingStatus === "past_due"
            ? 30
            : input.billingStatus === "canceled"
              ? 10
              : 50,
      reason: `Subscription status is ${input.billingStatus}`,
    },
    {
      key: "feature_adoption",
      score: clamp(
        (Number(types.has("api_key.created")) +
          Number(types.has("first_event.ingested")) +
          Number(types.has("first_opportunity.viewed")) +
          Number(types.has("webhook.created"))) *
          25,
      ),
      reason: "Counts API keys, ingest, intelligence views, and webhooks",
    },
  ];
  const overall = clamp(
    components.reduce((sum, row) => sum + row.score, 0) / components.length,
  );
  return {
    version: "health.v1",
    overall,
    components: [
      ...components,
      {
        key: "profile_present",
        score: profile ? 100 : 0,
        reason: profile ? "CRM profile exists" : "Missing CRM profile",
      },
    ],
  };
}

export { monthStartUtc };
