import { StripeNotConfiguredError } from "./stripe-env.js";
import { createCheckoutSession, createPortalSession } from "./checkout.js";
import { resolveBillingMode } from "./mode.js";
import type { Database } from "@isp/db";

export type BillingCheckoutAdapter = {
  mode: "local_simulation" | "stripe_test";
  startCheckout: typeof createCheckoutSession;
  openPortal: typeof createPortalSession;
};

export function createBillingCheckoutAdapter(
  env: NodeJS.ProcessEnv = process.env,
): BillingCheckoutAdapter {
  const mode = resolveBillingMode(env);
  if (mode === "local_simulation") {
    return {
      mode,
      async startCheckout() {
        throw new StripeNotConfiguredError();
      },
      async openPortal() {
        throw new StripeNotConfiguredError();
      },
    };
  }
  return {
    mode: "stripe_test",
    startCheckout: createCheckoutSession,
    openPortal: createPortalSession,
  };
}

export async function startCheckoutWithAdapter(
  scoped: Database,
  input: Parameters<typeof createCheckoutSession>[1],
) {
  const adapter = createBillingCheckoutAdapter(input.env);
  return adapter.startCheckout(scoped, input);
}

export async function openPortalWithAdapter(
  scoped: Database,
  input: Parameters<typeof createPortalSession>[1],
) {
  const adapter = createBillingCheckoutAdapter(input.env);
  return adapter.openPortal(scoped, input);
}
