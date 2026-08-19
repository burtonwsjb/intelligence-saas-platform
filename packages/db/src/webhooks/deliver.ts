import { and, eq, lte } from "drizzle-orm";
import type { Database } from "../client.js";
import { webhookDelivery, webhookEndpoint } from "../schema/webhook.js";
import {
  MAX_WEBHOOK_ATTEMPTS,
  WEBHOOK_DISABLE_AFTER_FAILURES,
  WEBHOOK_RESPONSE_EXCERPT_CHARS,
  WEBHOOK_RETRY_VERSION,
} from "./catalog.js";
import { decryptWebhookSecret, signWebhookPayload } from "./secret.js";
import { assertWebhookDestinationSafe, type DnsLookup } from "./ssrf.js";

export type WebhookFetch = (input: {
  url: string;
  body: string;
  headers: Record<string, string>;
}) => Promise<{ status: number; bodyText: string }>;

function retryDelayMs(attempt: number): number {
  return Math.min(60_000 * 2 ** Math.max(attempt - 1, 0), 24 * 60 * 60 * 1000);
}

function excerpt(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, WEBHOOK_RESPONSE_EXCERPT_CHARS);
}

function isPermanentHttp(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export async function processDueWebhookDeliveries(
  scoped: Database,
  input: {
    organizationId: string;
    pepper: string;
    now?: Date;
    fetchImpl: WebhookFetch;
    lookup?: DnsLookup;
  },
) {
  const now = input.now ?? new Date();
  const due = await scoped
    .select()
    .from(webhookDelivery)
    .where(
      and(
        eq(webhookDelivery.organizationId, input.organizationId),
        eq(webhookDelivery.status, "pending"),
        lte(webhookDelivery.nextRetryAt, now),
      ),
    );
  const results = [];
  for (const delivery of due) {
    results.push(await attemptWebhookDelivery(scoped, { ...input, delivery, now }));
  }
  return results;
}

export async function attemptWebhookDelivery(
  scoped: Database,
  input: {
    organizationId: string;
    pepper: string;
    now: Date;
    fetchImpl: WebhookFetch;
    lookup?: DnsLookup;
    delivery: typeof webhookDelivery.$inferSelect;
  },
) {
  const endpoint = await scoped
    .select()
    .from(webhookEndpoint)
    .where(eq(webhookEndpoint.id, input.delivery.endpointId))
    .then((rows) => rows[0] ?? null);
  if (!endpoint || endpoint.status !== "active") {
    const [dead] = await scoped
      .update(webhookDelivery)
      .set({ status: "dead", errorClass: "endpoint_disabled", attempt: input.delivery.attempt + 1 })
      .where(eq(webhookDelivery.id, input.delivery.id))
      .returning();
    return dead!;
  }
  const attempt = input.delivery.attempt + 1;
  try {
    await assertWebhookDestinationSafe(endpoint.url, input.lookup);
    const secret = decryptWebhookSecret(endpoint.secretCiphertext, input.pepper);
    const timestamp = String(input.now.getTime());
    const body = JSON.stringify({
      id: input.delivery.eventId,
      type: input.delivery.eventType,
      created_at: input.delivery.createdAt.toISOString(),
      delivery_id: input.delivery.id,
      delivery_attempt: attempt,
      signing_version: "hmac-sha256.v1",
      retry_version: WEBHOOK_RETRY_VERSION,
      data: input.delivery.payload,
    });
    const signature = signWebhookPayload({ secret, timestamp, body });
    const response = await input.fetchImpl({
      url: endpoint.url,
      body,
      headers: {
        "content-type": "application/json",
        "x-isp-signature": signature,
        "x-isp-timestamp": timestamp,
        "x-isp-event-id": input.delivery.eventId,
        "x-isp-delivery-id": input.delivery.id,
      },
    });
    if (response.status >= 200 && response.status < 300) {
      await scoped
        .update(webhookEndpoint)
        .set({ consecutiveFailures: 0, updatedAt: input.now })
        .where(eq(webhookEndpoint.id, endpoint.id));
      const [delivered] = await scoped
        .update(webhookDelivery)
        .set({
          attempt,
          status: "delivered",
          httpStatus: response.status,
          errorClass: null,
          responseExcerpt: excerpt(response.bodyText),
          deliveredAt: input.now,
          nextRetryAt: null,
        })
        .where(eq(webhookDelivery.id, input.delivery.id))
        .returning();
      return delivered!;
    }
    const permanent = isPermanentHttp(response.status);
    const dead = permanent || attempt >= MAX_WEBHOOK_ATTEMPTS;
    const failures = endpoint.consecutiveFailures + 1;
    if (failures >= WEBHOOK_DISABLE_AFTER_FAILURES) {
      await scoped
        .update(webhookEndpoint)
        .set({
          status: "disabled",
          disabledAt: input.now,
          consecutiveFailures: failures,
          updatedAt: input.now,
        })
        .where(eq(webhookEndpoint.id, endpoint.id));
    } else {
      await scoped
        .update(webhookEndpoint)
        .set({ consecutiveFailures: failures, updatedAt: input.now })
        .where(eq(webhookEndpoint.id, endpoint.id));
    }
    const [updated] = await scoped
      .update(webhookDelivery)
      .set({
        attempt,
        status: dead ? "dead" : "pending",
        httpStatus: response.status,
        errorClass: permanent ? "http_4xx" : "http_5xx",
        responseExcerpt: excerpt(response.bodyText),
        nextRetryAt: dead ? null : new Date(input.now.getTime() + retryDelayMs(attempt)),
      })
      .where(eq(webhookDelivery.id, input.delivery.id))
      .returning();
    return updated!;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, WEBHOOK_RESPONSE_EXCERPT_CHARS) : "delivery_failed";
    const dead = attempt >= MAX_WEBHOOK_ATTEMPTS;
    const [updated] = await scoped
      .update(webhookDelivery)
      .set({
        attempt,
        status: dead ? "dead" : "pending",
        errorClass: "delivery_error",
        responseExcerpt: message,
        nextRetryAt: dead ? null : new Date(input.now.getTime() + retryDelayMs(attempt)),
      })
      .where(eq(webhookDelivery.id, input.delivery.id))
      .returning();
    return updated!;
  }
}
