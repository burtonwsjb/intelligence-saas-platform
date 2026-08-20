export const ISP_ENVIRONMENTS = ["local", "test", "staging", "production"] as const;
export type IspEnvironment = (typeof ISP_ENVIRONMENTS)[number];

export class InvalidRuntimeEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRuntimeEnvError";
  }
}

export function parseIspEnv(env: NodeJS.ProcessEnv = process.env): IspEnvironment {
  const explicit = env.ISP_ENV?.trim().toLowerCase();
  if (explicit) {
    if ((ISP_ENVIRONMENTS as readonly string[]).includes(explicit)) {
      return explicit as IspEnvironment;
    }
    throw new InvalidRuntimeEnvError("ISP_ENV must be local, test, staging, or production.");
  }
  const nodeEnv = env.NODE_ENV?.trim();
  if (nodeEnv === "test") {
    return "test";
  }
  if (nodeEnv === "production") {
    return "production";
  }
  if (nodeEnv === "staging") {
    return "staging";
  }
  return "local";
}

export function isHostedRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  const isp = parseIspEnv(env);
  return isp === "staging" || isp === "production";
}

export function isProductionRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseIspEnv(env) === "production";
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i;

export function isLocalHostname(url: string): boolean {
  try {
    const parsed = new URL(url);
    return LOCAL_HOST.test(parsed.hostname) || parsed.hostname.endsWith(".localhost");
  } catch {
    return true;
  }
}

export function assertHttpsPublicUrl(label: string, value: string | undefined): string {
  const url = value?.trim();
  if (!url) {
    throw new InvalidRuntimeEnvError(`${label} is required.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidRuntimeEnvError(`${label} must be a valid URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new InvalidRuntimeEnvError(`${label} must use https in hosted environments.`);
  }
  if (LOCAL_HOST.test(parsed.hostname) || parsed.hostname.endsWith(".localhost")) {
    throw new InvalidRuntimeEnvError(`${label} must not use a loopback host in hosted environments.`);
  }
  return url;
}

export function assertHostedSecrets(env: NodeJS.ProcessEnv = process.env): void {
  if (!isHostedRuntime(env)) {
    return;
  }
  if (env.PLATFORM_ADMIN_EMAILS?.trim()) {
    throw new InvalidRuntimeEnvError(
      "PLATFORM_ADMIN_EMAILS is forbidden in staging and production. Use platform_admins rows.",
    );
  }
  if (env.BILLING_MODE?.trim() === "local_simulation") {
    throw new InvalidRuntimeEnvError("Local billing simulation is forbidden in staging and production.");
  }
  const emailMode = env.AUTH_EMAIL_MODE?.trim();
  if (emailMode && emailMode !== "resend") {
    throw new InvalidRuntimeEnvError("Hosted environments must use AUTH_EMAIL_MODE=resend.");
  }
  if (env.QUEUE_PREFIX?.trim() && /^(local|test|ci|dev)$/i.test(env.QUEUE_PREFIX.trim())) {
    throw new InvalidRuntimeEnvError("QUEUE_PREFIX must not reuse local/test identifiers in hosted environments.");
  }
  assertHttpsPublicUrl("APP_URL", env.APP_URL);
  if (env.BETTER_AUTH_URL?.trim()) {
    assertHttpsPublicUrl("BETTER_AUTH_URL", env.BETTER_AUTH_URL);
  }
  if (isProductionRuntime(env)) {
    const redis = env.REDIS_URL?.trim();
    if (redis && !redis.startsWith("rediss://") && env.REDIS_TLS !== "optional") {
      throw new InvalidRuntimeEnvError(
        "Production REDIS_URL must use rediss:// unless REDIS_TLS=optional is set for a private network.",
      );
    }
  }
}

export function assertProductionIdentifiers(env: NodeJS.ProcessEnv = process.env): void {
  if (!isProductionRuntime(env)) {
    return;
  }
  if (env.QUEUE_PREFIX?.trim() && /staging/i.test(env.QUEUE_PREFIX)) {
    throw new InvalidRuntimeEnvError("Production QUEUE_PREFIX must not contain staging.");
  }
  const appUrl = env.APP_URL ?? "";
  if (/staging/i.test(appUrl)) {
    throw new InvalidRuntimeEnvError("Production APP_URL must not use a staging hostname.");
  }
}

export function defaultPublicOrigin(env: NodeJS.ProcessEnv = process.env): string {
  if (isHostedRuntime(env)) {
    return assertHttpsPublicUrl("APP_URL", env.APP_URL);
  }
  return env.APP_URL?.trim() || env.BETTER_AUTH_URL?.trim() || "http://localhost:3000";
}
