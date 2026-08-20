import { isHostedRuntime } from "@isp/shared";

export const PREDICTIONS_CUSTOMER_FLAG = "PREDICTIONS_CUSTOMER_VISIBLE";

export function customerPredictionsEnabled(
  env: NodeJS.ProcessEnv = process.env,
  options?: { platformFlag?: boolean },
): boolean {
  const envOn = env[PREDICTIONS_CUSTOMER_FLAG]?.trim() === "true";
  if (isHostedRuntime(env)) {
    return options?.platformFlag === true;
  }
  return envOn || options?.platformFlag === true;
}
