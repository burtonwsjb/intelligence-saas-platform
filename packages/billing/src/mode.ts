import { LiveStripeForbiddenError } from "./stripe-env.js";

export const BILLING_MODES = [
  "local_simulation",
  "stripe_test",
  "stripe_live",
] as const;

export type BillingMode = (typeof BILLING_MODES)[number];

export class ProductionBillingSimulationError extends Error {
  constructor() {
    super("Local billing simulation is unavailable in production.");
    this.name = "ProductionBillingSimulationError";
  }
}

export class BillingSimulationUnavailableError extends Error {
  constructor() {
    super("Local billing simulation is only available in non-production local_simulation mode.");
    this.name = "BillingSimulationUnavailableError";
  }
}

export function resolveBillingMode(
  env: NodeJS.ProcessEnv = process.env,
): Exclude<BillingMode, "stripe_live"> {
  const requested = env.BILLING_MODE?.trim();
  if (requested === "stripe_live") {
    throw new LiveStripeForbiddenError();
  }
  if (env.NODE_ENV === "production") {
    if (requested === "local_simulation") {
      throw new ProductionBillingSimulationError();
    }
    return "stripe_test";
  }
  if (requested === "stripe_test") {
    return "stripe_test";
  }
  return "local_simulation";
}

export function isLocalBillingSimulationAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NODE_ENV === "production") {
    return false;
  }
  return resolveBillingMode(env) === "local_simulation";
}

export function requireLocalBillingSimulation(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV === "production") {
    throw new ProductionBillingSimulationError();
  }
  if (resolveBillingMode(env) !== "local_simulation") {
    throw new BillingSimulationUnavailableError();
  }
}
