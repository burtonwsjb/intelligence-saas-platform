import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  countActiveApiKeys,
  insertApiKey,
  insertAuditEvent,
  listApiKeys,
  lookupApiKeyByPrefix,
  revokeApiKey,
  type Database,
} from "@isp/db";
import { requirePermission } from "./rbac.js";

export const ISSUABLE_SCOPES = ["ingest:write", "decisions:read"] as const;
export const KNOWN_SCOPES = [
  ...ISSUABLE_SCOPES,
  "receipts:write",
  "cards:read",
  "prices:read",
  "markets:read",
  "signals:read",
  "creators:read",
  "predictions:read",
  "opportunities:read",
  "content:read",
  "webhooks:manage",
] as const;

export type IssuableScope = (typeof ISSUABLE_SCOPES)[number];
export type KnownScope = (typeof KNOWN_SCOPES)[number];

export class MissingApiKeyPepperError extends Error {
  constructor() {
    super("API_KEY_PEPPER is not set.");
    this.name = "MissingApiKeyPepperError";
  }
}

export class UnknownScopeError extends Error {
  constructor() {
    super("Unknown API key scope.");
    this.name = "UnknownScopeError";
  }
}

export class ApiKeyDeniedError extends Error {
  constructor() {
    super("API key is not valid.");
    this.name = "ApiKeyDeniedError";
  }
}

export class InvalidApiKeyNameError extends Error {
  constructor() {
    super("API key name is invalid.");
    this.name = "InvalidApiKeyNameError";
  }
}

export function requireApiKeyPepper(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env.API_KEY_PEPPER?.trim();
  if (!value || value.length < 16) {
    throw new MissingApiKeyPepperError();
  }
  return value;
}

export function parseScopes(raw: unknown): IssuableScope[] {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(",")
      : [];
  const scopes = values.map((value) => String(value).trim()).filter(Boolean);
  if (scopes.length === 0) {
    throw new UnknownScopeError();
  }
  for (const scope of scopes) {
    if (!(ISSUABLE_SCOPES as readonly string[]).includes(scope)) {
      throw new UnknownScopeError();
    }
  }
  return [...new Set(scopes)] as IssuableScope[];
}

export function hasScope(granted: string[], needed: string): boolean {
  if (!(KNOWN_SCOPES as readonly string[]).includes(needed)) {
    return false;
  }
  return granted.includes(needed);
}

export function hashApiKeySecret(fullKey: string, pepper: string): string {
  return createHmac("sha256", pepper).update(fullKey).digest("hex");
}

function hashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  if (a.length !== b.length || a.length === 0) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function parsePresentedApiKey(value: string): {
  prefix: string;
  fullKey: string;
} | null {
  const trimmed = value.trim();
  const match = /^isp_test_([a-f0-9]{8})_[A-Za-z0-9_-]{16,}$/.exec(trimmed);
  if (!match) {
    return null;
  }
  return { prefix: `isp_test_${match[1]}`, fullKey: trimmed };
}

export function generateApiKeySecret(pepper: string): {
  fullKey: string;
  prefix: string;
  secretHash: string;
} {
  const publicPrefix = randomBytes(4).toString("hex");
  const secret = randomBytes(24).toString("base64url");
  const prefix = `isp_test_${publicPrefix}`;
  const fullKey = `${prefix}_${secret}`;
  return { fullKey, prefix, secretHash: hashApiKeySecret(fullKey, pepper) };
}

export async function createTenantApiKey(
  scoped: Database,
  input: {
    organizationId: string;
    actorUserId: string;
    actorRole: string | null | undefined;
    name: string;
    scopes: unknown;
    pepper: string;
    expiresAt?: Date | null;
  },
): Promise<{ id: string; fullKey: string; prefix: string; scopes: string[] }> {
  requirePermission(input.actorRole, "canManageApiKeys");
  const name = input.name.trim();
  if (name.length < 1 || name.length > 80) {
    throw new InvalidApiKeyNameError();
  }
  const scopes = parseScopes(input.scopes);
  const generated = generateApiKeySecret(input.pepper);
  const id = crypto.randomUUID();
  await insertApiKey(scoped, {
    id,
    organizationId: input.organizationId,
    name,
    prefix: generated.prefix,
    secretHash: generated.secretHash,
    scopes: scopes.join(","),
    createdByUserId: input.actorUserId,
    expiresAt: input.expiresAt,
  });
  await insertAuditEvent(scoped, {
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: "api_key.created",
    targetType: "api_key",
    targetId: id,
    metadata: { prefix: generated.prefix, scopes },
  });
  return { id, fullKey: generated.fullKey, prefix: generated.prefix, scopes };
}

export async function revokeTenantApiKey(
  scoped: Database,
  input: {
    organizationId: string;
    actorUserId: string;
    actorRole: string | null | undefined;
    apiKeyId: string;
  },
): Promise<void> {
  requirePermission(input.actorRole, "canManageApiKeys");
  const updated = await revokeApiKey(scoped, {
    id: input.apiKeyId,
    organizationId: input.organizationId,
  });
  if (updated === 0) {
    throw new ApiKeyDeniedError();
  }
  await insertAuditEvent(scoped, {
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: "api_key.revoked",
    targetType: "api_key",
    targetId: input.apiKeyId,
  });
}

export async function rotateTenantApiKey(
  scoped: Database,
  input: {
    organizationId: string;
    actorUserId: string;
    actorRole: string | null | undefined;
    apiKeyId: string;
    name: string;
    scopes: unknown;
    pepper: string;
  },
): Promise<{ id: string; fullKey: string; prefix: string; scopes: string[] }> {
  const created = await createTenantApiKey(scoped, input);
  await revokeTenantApiKey(scoped, input);
  await insertAuditEvent(scoped, {
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: "api_key.rotated",
    targetType: "api_key",
    targetId: created.id,
    metadata: { revoked: input.apiKeyId },
  });
  return created;
}

export async function verifyPresentedApiKey(
  db: Database,
  presented: string,
  pepper: string,
) {
  const parsed = parsePresentedApiKey(presented);
  if (!parsed) {
    throw new ApiKeyDeniedError();
  }
  const row = await lookupApiKeyByPrefix(db, parsed.prefix);
  if (!row || !hashesEqual(row.secretHash, hashApiKeySecret(parsed.fullKey, pepper))) {
    throw new ApiKeyDeniedError();
  }
  if (row.status !== "active" || row.revokedAt) {
    throw new ApiKeyDeniedError();
  }
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    throw new ApiKeyDeniedError();
  }
  return row;
}

export { countActiveApiKeys, listApiKeys };
