import type { PlanKey } from "./entitlements.js";

/**
 * Dollar prices are not decided. Local UI shows configuration/TBD only.
 * Do not treat these labels as production prices.
 */
export const PLAN_PRICE_DISPLAY: Record<
  PlanKey,
  { amountUsd: null; label: string; configured: boolean }
> = {
  free: { amountUsd: null, label: "Free", configured: true },
  starter: { amountUsd: null, label: "TBD", configured: false },
  growth: { amountUsd: null, label: "TBD", configured: false },
  scale: { amountUsd: null, label: "TBD", configured: false },
};
