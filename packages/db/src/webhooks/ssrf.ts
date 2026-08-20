export class WebhookUrlRejectedError extends Error {
  constructor(message = "Webhook URL is not allowed.") {
    super(message);
    this.name = "WebhookUrlRejectedError";
  }
}

export const MAX_WEBHOOK_URL_CHARS = 2048;

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "metadata.azure.com",
]);

function ipv4Parts(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const nums = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return Number.NaN;
    }
    if (part.length > 1 && part.startsWith("0")) {
      return Number.NaN;
    }
    return Number(part);
  });
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return nums;
}

function dottedNumericHost(host: string): boolean {
  return /^(\d{1,3}\.){0,3}\d{1,3}$/.test(host);
}

function ipv4FromDword(host: string): string | null {
  if (/^0x[0-9a-f]+$/i.test(host)) {
    const n = Number.parseInt(host, 16);
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) {
      return "0.0.0.0";
    }
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  }
  if (/^\d+$/.test(host)) {
    const n = Number(host);
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) {
      return "0.0.0.0";
    }
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  }
  return null;
}

export function isBlockedIPv4(host: string): boolean {
  if (/(^|\.)0\d/.test(host) && /^[\d.]+$/.test(host)) {
    return true;
  }
  const dword = ipv4FromDword(host);
  const target = dword ?? host;
  const parts = ipv4Parts(target);
  if (!parts) {
    if (dottedNumericHost(host) && ipv4Parts(host) == null) {
      return true;
    }
    if (dword) {
      return isBlockedIPv4(dword);
    }
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

function ipv4FromMappedHex(mapped: string): string | null {
  const match = mapped.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!match) {
    return null;
  }
  const high = Number.parseInt(match[1]!, 16);
  const low = Number.parseInt(match[2]!, 16);
  return [(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255].join(".");
}

export function isBlockedIPv6(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1" || normalized === "::" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }
  if (normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }
  if (normalized.startsWith("64:ff9b:")) {
    return true;
  }
  const dotted = normalized.match(/(?:^::ffff:|:ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (dotted?.[1]) {
    return isBlockedIPv4(dotted[1]);
  }
  const hexMapped = normalized.match(/(?:^::ffff:|:ffff:)([0-9a-f]{1,4}:[0-9a-f]{1,4})$/i);
  if (hexMapped?.[1]) {
    const ipv4 = ipv4FromMappedHex(hexMapped[1]);
    return ipv4 ? isBlockedIPv4(ipv4) : true;
  }
  if (normalized.startsWith("::ffff:")) {
    const rest = normalized.slice("::ffff:".length);
    const ipv4 = ipv4FromMappedHex(rest);
    return ipv4 ? isBlockedIPv4(ipv4) : isBlockedIPv4(rest);
  }
  return false;
}

export function parseWebhookUrl(raw: string): URL {
  if (raw.length > MAX_WEBHOOK_URL_CHARS) {
    throw new WebhookUrlRejectedError("Webhook URL is too long.");
  }
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
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".internal")) {
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

export function assertRedirectTargetSafe(location: string | null, originUrl: URL): void {
  if (!location) {
    throw new WebhookUrlRejectedError("Webhook redirect is missing a Location.");
  }
  const next = new URL(location, originUrl);
  assertPublicWebhookUrl(next.toString());
  if (next.hostname !== originUrl.hostname) {
    throw new WebhookUrlRejectedError("Webhook redirects to a different host are not followed.");
  }
}
