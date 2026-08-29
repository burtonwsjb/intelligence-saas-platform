const CONNECTION_STRING =
  /(?:postgres(?:ql)?|redis[s]?|mongodb(?:\+srv)?|mysql|amqp|https?):\/\/[^\s"'\\]+/gi;
const CREDENTIAL_VALUE =
  /\b(?:sk_live_|sk_test_|whsec_|re_)[A-Za-z0-9]+|\bisp_(?:test|live)_[A-Za-z0-9]+|Bearer\s+[A-Za-z0-9._-]+|password\s*[=:]\s*\S+/gi;

const SECRET_ENV_KEYS = [
  "APP_DATABASE_URL",
  "DATABASE_URL",
  "DATABASE_ADMIN_URL",
  "WORKER_DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "APP_ADMIN_PASSWORD",
  "APP_USER_PASSWORD",
  "APP_WORKER_PASSWORD",
  "APP_MIGRATE_PASSWORD",
  "REDIS_URL",
  "API_KEY_PEPPER",
  "RESEND_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "TCC_API_TOKEN",
  "TCGPLAYER_PRIVATE_KEY",
  "EBAY_OAUTH_TOKEN",
  "REDDIT_CLIENT_SECRET",
  "YOUTUBE_API_KEY",
  "CREATOR_LLM_API_KEY",
] as const;

function present(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

export function sanitizeAuthErrorMessage(message: string): string {
  return message.replace(CONNECTION_STRING, "[redacted]").replace(CREDENTIAL_VALUE, "[redacted]");
}

function stripKnownSecretValues(serialized: string, env: NodeJS.ProcessEnv): string {
  let out = serialized;
  for (const key of SECRET_ENV_KEYS) {
    const value = env[key]?.trim();
    if (!value || value.length < 8) {
      continue;
    }
    if (out.includes(value)) {
      out = out.split(value).join("[redacted]");
    }
  }
  return out;
}

export type AuthConfigDiagnostic = {
  event: "auth.config_error";
  error_name: string;
  error_message: string;
  ISP_ENV: string;
  APP_DATABASE_URL_present: boolean;
  BETTER_AUTH_SECRET_present: boolean;
  BETTER_AUTH_SECRET_length: number;
  APP_URL_present: boolean;
  BETTER_AUTH_URL_present: boolean;
  BILLING_MODE_present: boolean;
  AUTH_EMAIL_MODE_present: boolean;
};

export function buildAuthConfigDiagnostic(
  error: unknown,
  env: NodeJS.ProcessEnv = process.env,
): AuthConfigDiagnostic {
  const errorName = error instanceof Error ? error.name : "Error";
  const rawMessage = error instanceof Error ? error.message : "unknown";
  return {
    event: "auth.config_error",
    error_name: errorName,
    error_message: sanitizeAuthErrorMessage(rawMessage),
    ISP_ENV: env.ISP_ENV?.trim() || "(unset)",
    APP_DATABASE_URL_present: present(env.APP_DATABASE_URL),
    BETTER_AUTH_SECRET_present: present(env.BETTER_AUTH_SECRET),
    BETTER_AUTH_SECRET_length: env.BETTER_AUTH_SECRET?.trim().length ?? 0,
    APP_URL_present: present(env.APP_URL),
    BETTER_AUTH_URL_present: present(env.BETTER_AUTH_URL),
    BILLING_MODE_present: present(env.BILLING_MODE),
    AUTH_EMAIL_MODE_present: present(env.AUTH_EMAIL_MODE),
  };
}

export function serializeAuthConfigDiagnostic(
  error: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return stripKnownSecretValues(JSON.stringify(buildAuthConfigDiagnostic(error, env)), env);
}

export function logAuthConfigError(error: unknown, env: NodeJS.ProcessEnv = process.env): void {
  console.error(serializeAuthConfigDiagnostic(error, env));
}
