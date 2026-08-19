export class MissingStripeSecretError extends Error {
  constructor() {
    super("STRIPE_SECRET_KEY is not set. Stripe test-mode operations cannot run.");
    this.name = "MissingStripeSecretError";
  }
}

export class LiveStripeForbiddenError extends Error {
  constructor() {
    super("Live Stripe keys are forbidden. Use a test-mode secret only.");
    this.name = "LiveStripeForbiddenError";
  }
}

export class MissingStripeWebhookSecretError extends Error {
  constructor() {
    super("STRIPE_WEBHOOK_SECRET is not set.");
    this.name = "MissingStripeWebhookSecretError";
  }
}

export class StripeNotConfiguredError extends Error {
  constructor() {
    super("Stripe test prices are not configured.");
    this.name = "StripeNotConfiguredError";
  }
}

export function requireStripeSecret(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env.STRIPE_SECRET_KEY?.trim();
  if (!value) {
    throw new MissingStripeSecretError();
  }
  if (value.startsWith("sk_live_")) {
    throw new LiveStripeForbiddenError();
  }
  if (!value.startsWith("sk_test_")) {
    throw new LiveStripeForbiddenError();
  }
  return value;
}

export function requireStripeWebhookSecret(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!value) {
    throw new MissingStripeWebhookSecretError();
  }
  if (value.startsWith("whsec_live_")) {
    throw new LiveStripeForbiddenError();
  }
  return value;
}

export function stripePriceIdForPlan(
  planKey: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const map: Record<string, string | undefined> = {
    starter: env.STRIPE_PRICE_STARTER,
    growth: env.STRIPE_PRICE_GROWTH,
    scale: env.STRIPE_PRICE_SCALE,
  };
  const value = map[planKey]?.trim();
  if (!value || !value.startsWith("price_")) {
    throw new StripeNotConfiguredError();
  }
  return value;
}

export function planKeyFromPriceId(
  priceId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!priceId) {
    return "free";
  }
  if (priceId === env.STRIPE_PRICE_STARTER?.trim()) {
    return "starter";
  }
  if (priceId === env.STRIPE_PRICE_GROWTH?.trim()) {
    return "growth";
  }
  if (priceId === env.STRIPE_PRICE_SCALE?.trim()) {
    return "scale";
  }
  return "free";
}
