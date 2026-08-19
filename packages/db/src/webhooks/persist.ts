import { and, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { webhookDelivery, webhookEndpoint } from "../schema/webhook.js";
import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from "./catalog.js";
import { encryptWebhookSecret, generateWebhookSecret, hashWebhookSecret } from "./secret.js";
import { assertPublicWebhookUrl } from "./ssrf.js";

export function isWebhookEventType(value: string): value is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

export async function insertWebhookEndpoint(
  scoped: Database,
  input: {
    organizationId: string;
    url: string;
    eventTypes: string[];
    pepper: string;
  },
) {
  assertPublicWebhookUrl(input.url);
  const events = [...new Set(input.eventTypes)];
  if (events.length === 0 || events.some((event) => !isWebhookEventType(event))) {
    throw new Error("Unsupported webhook event type.");
  }
  const secret = generateWebhookSecret();
  const id = crypto.randomUUID();
  const [row] = await scoped
    .insert(webhookEndpoint)
    .values({
      id,
      organizationId: input.organizationId,
      url: input.url,
      secretCiphertext: encryptWebhookSecret(secret, input.pepper),
      secretHash: hashWebhookSecret(secret, input.pepper),
      eventTypes: events,
      status: "active",
    })
    .returning();
  return { endpoint: row!, secret };
}

export async function listWebhookEndpoints(scoped: Database, organizationId: string) {
  return scoped.select().from(webhookEndpoint).where(eq(webhookEndpoint.organizationId, organizationId));
}

export async function disableWebhookEndpoint(
  scoped: Database,
  input: { organizationId: string; endpointId: string },
) {
  const [row] = await scoped
    .update(webhookEndpoint)
    .set({ status: "disabled", disabledAt: new Date(), updatedAt: new Date() })
    .where(and(eq(webhookEndpoint.id, input.endpointId), eq(webhookEndpoint.organizationId, input.organizationId)))
    .returning();
  return row ?? null;
}

export async function getWebhookEndpoint(scoped: Database, input: { organizationId: string; endpointId: string }) {
  const [row] = await scoped
    .select()
    .from(webhookEndpoint)
    .where(and(eq(webhookEndpoint.id, input.endpointId), eq(webhookEndpoint.organizationId, input.organizationId)))
    .limit(1);
  return row ?? null;
}

export async function enqueueWebhookDelivery(
  scoped: Database,
  input: {
    organizationId: string;
    endpointId: string;
    eventId: string;
    eventType: WebhookEventType;
    payload: Record<string, unknown>;
  },
) {
  const [existing] = await scoped
    .select()
    .from(webhookDelivery)
    .where(and(eq(webhookDelivery.endpointId, input.endpointId), eq(webhookDelivery.eventId, input.eventId)))
    .limit(1);
  if (existing) {
    return existing;
  }
  const [row] = await scoped
    .insert(webhookDelivery)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      endpointId: input.endpointId,
      eventId: input.eventId,
      eventType: input.eventType,
      payload: input.payload,
      status: "pending",
      nextRetryAt: new Date(),
    })
    .returning();
  return row!;
}

export async function listWebhookDeliveries(scoped: Database, organizationId: string) {
  return scoped.select().from(webhookDelivery).where(eq(webhookDelivery.organizationId, organizationId));
}
