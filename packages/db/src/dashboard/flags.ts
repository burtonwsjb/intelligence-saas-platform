export const PREDICTIONS_CUSTOMER_FLAG = "PREDICTIONS_CUSTOMER_VISIBLE";

export function customerPredictionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PREDICTIONS_CUSTOMER_FLAG]?.trim() === "true";
}
