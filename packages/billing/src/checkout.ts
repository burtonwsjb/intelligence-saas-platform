import Stripe from "stripe";
import {
  getTenantBilling,
  insertAuditEvent,
  upsertTenantBilling,
  type Database,
} from "@isp/db";
import { resolveBillingMode } from "./mode.js";
import {
  requireStripeSecret,
  stripePriceIdForPlan,
  StripeNotConfiguredError,
} from "./stripe-env.js";
import { isKnownPlan } from "./entitlements.js";

export async function createCheckoutSession(
  scoped: Database,
  input: {
    organizationId: string;
    actorUserId: string;
    planKey: string;
    successUrl: string;
    cancelUrl: string;
    tenantName: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ url: string }> {
  if (!isKnownPlan(input.planKey) || input.planKey === "free") {
    throw new StripeNotConfiguredError();
  }
  if (resolveBillingMode(input.env) === "local_simulation") {
    throw new StripeNotConfiguredError();
  }
  const secret = requireStripeSecret(input.env);
  const priceId = stripePriceIdForPlan(input.planKey, input.env);
  const stripe = new Stripe(secret);
  const billing = await getTenantBilling(scoped, input.organizationId);
  let customerId = billing?.stripeCustomerId ?? null;
  if (!customerId) {
    const customer = await stripe.customers.create({
      name: input.tenantName,
      metadata: { organization_id: input.organizationId },
    });
    customerId = customer.id;
    await upsertTenantBilling(scoped, {
      organizationId: input.organizationId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: billing?.stripeSubscriptionId ?? null,
      planKey: billing?.planKey ?? "free",
      status: billing?.status ?? "none",
      currentPeriodEnd: billing?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: billing?.cancelAtPeriodEnd ?? false,
    });
  }
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    client_reference_id: input.organizationId,
    metadata: { organization_id: input.organizationId, plan_key: input.planKey },
    subscription_data: {
      metadata: { organization_id: input.organizationId, plan_key: input.planKey },
    },
  });
  if (!session.url) {
    throw new Error("Stripe Checkout did not return a URL.");
  }
  await insertAuditEvent(scoped, {
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: "subscription.checkout_started",
    targetType: "plan",
    targetId: input.planKey,
  });
  return { url: session.url };
}

export async function createPortalSession(
  scoped: Database,
  input: {
    organizationId: string;
    actorUserId: string;
    returnUrl: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ url: string }> {
  if (resolveBillingMode(input.env) === "local_simulation") {
    throw new StripeNotConfiguredError();
  }
  const secret = requireStripeSecret(input.env);
  const billing = await getTenantBilling(scoped, input.organizationId);
  if (!billing?.stripeCustomerId) {
    throw new StripeNotConfiguredError();
  }
  const stripe = new Stripe(secret);
  const session = await stripe.billingPortal.sessions.create({
    customer: billing.stripeCustomerId,
    return_url: input.returnUrl,
  });
  await insertAuditEvent(scoped, {
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: "billing.portal_opened",
    targetType: "stripe_customer",
    targetId: billing.stripeCustomerId,
  });
  return { url: session.url };
}
