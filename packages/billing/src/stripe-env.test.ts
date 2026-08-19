import { describe, expect, it } from "vitest";
import {
  LiveStripeForbiddenError,
  MissingStripeSecretError,
  requireStripeSecret,
  requireStripeWebhookSecret,
} from "./stripe-env.js";

describe("stripe env", () => {
  it("accepts test secrets and rejects live keys", () => {
    expect(requireStripeSecret({ STRIPE_SECRET_KEY: "sk_test_example" })).toBe(
      "sk_test_example",
    );
    expect(() => requireStripeSecret({})).toThrow(MissingStripeSecretError);
    expect(() =>
      requireStripeSecret({ STRIPE_SECRET_KEY: "sk_live_example" }),
    ).toThrow(LiveStripeForbiddenError);
    expect(() =>
      requireStripeWebhookSecret({ STRIPE_WEBHOOK_SECRET: "whsec_test" }),
    ).not.toThrow();
  });
});
