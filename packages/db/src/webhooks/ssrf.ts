export class WebhookUrlRejectedError extends Error {
  constructor(message = "Webhook URL is not allowed.") {
    super(message);
    this.name = "WebhookUrlRejectedError";
  }
}

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

function ipv4Parts(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return nums;
}

export function isBlockedIPv4(host: string): boolean {
  const parts = ipv4Parts(host);
  if (!parts) {
    return false;
  }
  const a = parts[0]!;
  const b = parts[1]!;
  if (a === 0 || a === 10 || a === 127 || a === 255) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  return false;
}

export function isBlockedIPv6(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1" || normalized === "::" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }
  if (normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return isBlockedIPv4(mapped);
  }
  return false;
}

export function parseWebhookUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new WebhookUrlRejectedError("Webhook URL is invalid.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new WebhookUrlRejectedError("Webhook URL must use http or https.");
  }
  if (parsed.username || parsed.password) {
    throw new WebhookUrlRejectedError("Webhook URL must not include credentials.");
  }
  const host = parsed.hostname.toLowerCase();
  if (!host) {
    throw new WebhookUrlRejectedError("Webhook URL host is required.");
  }
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost")) {
    throw new WebhookUrlRejectedError("Webhook URL host is not allowed.");
  }
  if (isBlockedIPv4(host) || isBlockedIPv6(host)) {
    throw new WebhookUrlRejectedError("Webhook URL resolves to a private or local address.");
  }
  return parsed;
}

export function assertPublicWebhookUrl(raw: string): URL {
  return parseWebhookUrl(raw);
}

export function assertResolvedAddressesPublic(addresses: string[]): void {
  if (addresses.length === 0) {
    throw new WebhookUrlRejectedError("Webhook URL host could not be resolved.");
  }
  for (const address of addresses) {
    const host = address.toLowerCase();
    if (isBlockedIPv4(host) || isBlockedIPv6(host) || BLOCKED_HOSTS.has(host)) {
      throw new WebhookUrlRejectedError("Webhook URL resolved to a private or local address.");
    }
  }
}

export type DnsLookup = (hostname: string) => Promise<string[]>;

export async function assertWebhookDestinationSafe(raw: string, lookup?: DnsLookup): Promise<URL> {
  const parsed = assertPublicWebhookUrl(raw);
  if (lookup) {
    const addresses = await lookup(parsed.hostname);
    assertResolvedAddressesPublic(addresses);
  }
  return parsed;
}
