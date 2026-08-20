import { isHostedRuntime } from "@isp/shared";

export const BREAK_GLASS_ACTIONS = [
  "tenant.inspect",
  "creator.exclude",
  "creator.trust",
  "index.upsert",
  "support.case",
  "predictions.preview",
  "health.view",
] as const;

export type BreakGlassAction = (typeof BREAK_GLASS_ACTIONS)[number];

export const SUPPORT_CASE_STATUSES = ["open", "pending", "closed"] as const;
export type SupportCaseStatus = (typeof SUPPORT_CASE_STATUSES)[number];

export const OPERATOR_TRUST_STATES = [
  "trusted",
  "reliable",
  "developing",
  "low_confidence",
  "unreliable",
  "excluded",
] as const;

export type OperatorTrustState = (typeof OPERATOR_TRUST_STATES)[number];

export const SECRET_SCAN =
  /sk_live_|sk_test_|whsec_|isp_(?:test|live)_[A-Za-z0-9]+|RESEND_API_KEY|BEGIN (?:RSA )?PRIVATE KEY|password\s*=/i;

export function isBreakGlassAction(value: string): value is BreakGlassAction {
  return (BREAK_GLASS_ACTIONS as readonly string[]).includes(value);
}

export function isSupportCaseStatus(value: string): value is SupportCaseStatus {
  return (SUPPORT_CASE_STATUSES as readonly string[]).includes(value);
}

export function isOperatorTrustState(value: string): value is OperatorTrustState {
  return (OPERATOR_TRUST_STATES as readonly string[]).includes(value);
}

export function parsePlatformAdminEmails(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.PLATFORM_ADMIN_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0 && !value.includes(" "));
}

export function isProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return isHostedRuntime(env);
}

/**
 * Local/dev convenience only. Production grants must exist in `platform_admins`.
 */
export function emailIsLocalPlatformAdmin(
  email: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isProductionEnv(env)) {
    return false;
  }
  const normalized = email?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return parsePlatformAdminEmails(env).includes(normalized);
}

export function sanitizeAuditMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!metadata) {
    return {};
  }
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const lower = key.toLowerCase();
    if (
      lower.includes("secret") ||
      lower.includes("password") ||
      lower.includes("token") ||
      lower.includes("key") ||
      lower.includes("pepper")
    ) {
      continue;
    }
    if (typeof value === "string" && SECRET_SCAN.test(value)) {
      continue;
    }
    clean[key] = value;
  }
  return clean;
}
