import Stripe from "stripe";
import {
  claimStripeEvent,
  findOrganizationIdByStripeCustomer,
  insertAuditEvent,
  upsertTenantBilling,
  withSystemContext,
  type Database,
} from "@isp/db";
import { planKeyFromPriceId, requireStripeWebhookSecret } from "./stripe-env.js";
import { normalizeSubscriptionStatus } from "./subscription.js";

export class InvalidStripeSignatureError extends Error {
  constructor() {
    super("Invalid Stripe webhook signature.");
    this.name = "InvalidStripeSignatureError";
  }
}

export class StripeCustomerMismatchError extends Error {
  constructor() {
    super("Stripe customer does not match this tenant.");
    this.name = "StripeCustomerMismatchError";
  }
}

const HANDLED = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
]);

export function constructStripeEvent(
  payload: string,
  signature: string | null,
  secret: string,
): Stripe.Event {
  if (!signature) {
    throw new InvalidStripeSignatureError();
  }
  try {
    return Stripe.webhooks.constructEvent(payload, signature, secret);
  } catch {
    throw new InvalidStripeSignatureError();
  }
}

function customerIdFromEvent(event: Stripe.Event): string | null {
  const object = event.data.object as {
    customer?: string | { id?: string } | null;
  };
  if (typeof object.customer === "string") {
    return object.customer;
  }
  return object.customer?.id ?? null;
}

function metadataOrganizationId(event: Stripe.Event): string | null {
  const object = event.data.object as { metadata?: { organization_id?: string } };
  return object.metadata?.organization_id ?? null;
}

function subscriptionFromEvent(event: Stripe.Event): Stripe.Subscription | null {
  if (event.type.startsWith("customer.subscription.")) {
    return event.data.object as Stripe.Subscription;
  }
  return null;
}

export async function processStripeWebhook(
  db: Database,
  input: {
    payload: string;
    signature: string | null;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ duplicate: boolean; ignored: boolean }> {
  const secret = requireStripeWebhookSecret(input.env);
  const event = constructStripeEvent(input.payload, input.signature, secret);
  const customerId = customerIdFromEvent(event);
  const mappedOrganizationId = customerId
    ? await findOrganizationIdByStripeCustomer(db, customerId)
    : null;
  const metadataOrg = metadataOrganizationId(event);
  if (metadataOrg && mappedOrganizationId && metadataOrg !== mappedOrganizationId) {
    throw new StripeCustomerMismatchError();
  }
  const organizationId = mappedOrganizationId;
  const claimed = await claimStripeEvent(db, {
    id: event.id,
    type: event.type,
    organizationId,
    stripeCustomerId: customerId,
  });
  if (!claimed) {
    return { duplicate: true, ignored: false };
  }
  if (!HANDLED.has(event.type) || !organizationId || !customerId) {
    return { duplicate: false, ignored: true };
  }

  const subscription = subscriptionFromEvent(event);
  const invoice = event.type.startsWith("invoice.")
    ? (event.data.object as Stripe.Invoice)
    : null;
  const priceId =
    subscription?.items.data[0]?.price.id ??
    invoice?.lines.data[0]?.pricing?.price_details?.price ??
    null;
  const status = normalizeSubscriptionStatus(
    subscription?.status ??
      (event.type === "invoice.payment_failed" ? "past_due" : "active"),
  );
  const planKey =
    event.type === "customer.subscription.deleted" ? "free" : planKeyFromPriceId(priceId, input.env);

  await withSystemContext(db, { organizationId }, async (scoped) => {
    await upsertTenantBilling(scoped, {
      organizationId,
      stripeCustomerId: customerId,
      stripeSubscriptionId:
        subscription?.id ??
        (typeof invoice?.parent === "object" && invoice?.parent && "subscription_details" in invoice.parent
          ? (invoice.parent as { subscription_details?: { subscription?: string } }).subscription_details
              ?.subscription ?? null
          : null),
      planKey: status === "canceled" ? "free" : planKey,
      status: event.type === "customer.subscription.deleted" ? "canceled" : status,
      currentPeriodEnd: subscription?.items.data[0]?.current_period_end
        ? new Date(subscription.items.data[0].current_period_end * 1000)
        : null,
      cancelAtPeriodEnd: subscription?.cancel_at_period_end ?? false,
    });
    await insertAuditEvent(scoped, {
      id: crypto.randomUUID(),
      organizationId,
      action: "subscription.changed",
      targetType: "subscription",
      targetId: subscription?.id ?? event.id,
      metadata: { type: event.type, status, planKey },
    });
  });
  return { duplicate: false, ignored: false };
}
