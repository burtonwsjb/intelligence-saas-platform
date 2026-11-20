import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isProductionRuntime } from "@isp/shared";
import {
  countActiveApiKeys,
  insertApiKey,
  insertAuditEvent,
  listApiKeys,
  lookupApiKeyByPrefix,
  revokeApiKey,
  getApiKeySettings,
  updateApiKeySettings,
  withSystemContext,
  type Database,
} from "@isp/db";
import { requirePermission } from "./rbac.js";

export const ISSUABLE_SCOPES = [
  "ingest:write",
  "decisions:read",
  "cards:read",
  "prices:read",
  "markets:read",
  "signals:read",
  "creators:read",
  "predictions:read",
  "opportunities:read",
  "webhooks:manage",
] as const;
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

export function apiKeyScheme(env: NodeJS.ProcessEnv = process.env): "isp_test" | "isp_live" {
  return isProductionRuntime(env) ? "isp_live" : "isp_test";
}

export function parsePresentedApiKey(value: string): {
  prefix: string;
  fullKey: string;
} | null {
  const trimmed = value.trim();
  const match = /^(isp_(?:test|live))_([a-f0-9]{8})_([A-Za-z0-9_-]{16,})$/.exec(trimmed);
  if (!match) {
    return null;
  }
  return { prefix: `${match[1]}_${match[2]}`, fullKey: trimmed };
}

export function generateApiKeySecret(
  pepper: string,
  env: NodeJS.ProcessEnv = process.env,
): {
  fullKey: string;
  prefix: string;
  secretHash: string;
} {
  const publicPrefix = randomBytes(4).toString("hex");
  const secret = randomBytes(24).toString("base64url");
  const prefix = `${apiKeyScheme(env)}_${publicPrefix}`;
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

/**
 * Read-only data scopes a customer API key gets by default when the operator
 * issues it from the admin console. Write scopes (ingest, webhooks) stay opt-in.
 */
export const CUSTOMER_READ_SCOPES = [
  "cards:read",
  "prices:read",
  "markets:read",
  "signals:read",
  "creators:read",
  "opportunities:read",
] as const satisfies readonly IssuableScope[];

/** Default per-minute limit for operator-issued keys. */
export const DEFAULT_OPERATOR_KEY_RATE_LIMIT = 60;
export const MAX_KEY_RATE_LIMIT = 10_000;

export class InvalidApiKeyLimitError extends Error {
  constructor() {
    super("Requests per minute must be a whole number from 1 to 10,000, or empty for no per-key limit.");
    this.name = "InvalidApiKeyLimitError";
  }
}

/** "" or missing = no per-key limit (null); otherwise a whole number 1..10,000. */
export function parseRateLimit(raw: unknown): number | null {
  const text = raw == null ? "" : String(raw).replaceAll(",", "").trim();
  if (text === "") return null;
  if (!/^\d+$/.test(text)) throw new InvalidApiKeyLimitError();
  const value = Number(text);
  if (value < 1 || value > MAX_KEY_RATE_LIMIT) throw new InvalidApiKeyLimitError();
  return value;
}

function cleanNote(raw: unknown): string | null {
  const text = raw == null ? "" : String(raw).trim();
  return text === "" ? null : text.slice(0, 500);
}

/**
 * Platform operator issues a key for any customer workspace from /admin.
 * Runs on the platform admin connection in a system context for that
 * organization. It skips the workspace member role check and the plan's
 * key-count cap on purpose: the operator is deciding who gets access.
 * The secret is returned once and only its hash is stored.
 */
export async function createOperatorApiKey(
  adminDb: Database,
  input: {
    organizationId: string;
    actorUserId: string;
    name: string;
    scopes: unknown;
    pepper: string;
    expiresAt?: Date | null;
    /** Requests per minute; "" or null = no per-key limit. */
    rateLimitPerMinute?: unknown;
    note?: unknown;
  },
): Promise<{ id: string; fullKey: string; prefix: string; scopes: string[] }> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 80) {
    throw new InvalidApiKeyNameError();
  }
  const scopes = parseScopes(input.scopes);
  const rateLimitPerMinute = parseRateLimit(input.rateLimitPerMinute);
  const note = cleanNote(input.note);
  const generated = generateApiKeySecret(input.pepper);
  const id = crypto.randomUUID();
  await withSystemContext(adminDb, { organizationId: input.organizationId }, async (scoped) => {
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
    await updateApiKeySettings(scoped, {
      id,
      organizationId: input.organizationId,
      rateLimitPerMinute,
      note,
      issuedByOperator: true,
    });
    await insertAuditEvent(scoped, {
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: "api_key.created",
      targetType: "api_key",
      targetId: id,
      metadata: { prefix: generated.prefix, scopes, issuedBy: "platform_operator" },
    });
  });
  return { id, fullKey: generated.fullKey, prefix: generated.prefix, scopes };
}

export async function revokeOperatorApiKey(
  adminDb: Database,
  input: { organizationId: string; actorUserId: string; apiKeyId: string },
): Promise<void> {
  await withSystemContext(adminDb, { organizationId: input.organizationId }, async (scoped) => {
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
      metadata: { revokedBy: "platform_operator" },
    });
  });
}

/**
 * Issues a replacement with the same name, scopes, per-minute limit, note and
 * expiry, then revokes the old key. The new secret is returned once.
 */
export async function rotateOperatorApiKey(
  adminDb: Database,
  input: { organizationId: string; actorUserId: string; apiKeyId: string; pepper: string },
): Promise<{ id: string; fullKey: string; prefix: string; scopes: string[] }> {
  const current = await withSystemContext(adminDb, { organizationId: input.organizationId }, (scoped) =>
    getApiKeySettings(scoped, { id: input.apiKeyId, organizationId: input.organizationId }),
  );
  if (!current || current.status !== "active") {
    throw new ApiKeyDeniedError();
  }
  const created = await createOperatorApiKey(adminDb, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    name: current.name,
    scopes: current.scopes,
    pepper: input.pepper,
    expiresAt: current.expiresAt,
    rateLimitPerMinute: current.rateLimitPerMinute == null ? "" : String(current.rateLimitPerMinute),
    note: current.note,
  });
  await revokeOperatorApiKey(adminDb, input);
  await withSystemContext(adminDb, { organizationId: input.organizationId }, (scoped) =>
    insertAuditEvent(scoped, {
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: "api_key.rotated",
      targetType: "api_key",
      targetId: created.id,
      metadata: { revoked: input.apiKeyId, rotatedBy: "platform_operator" },
    }),
  );
  return created;
}

/** Operator changes a key's per-minute limit and note. */
export async function updateOperatorApiKeySettings(
  adminDb: Database,
  input: { organizationId: string; actorUserId: string; apiKeyId: string; rateLimitPerMinute: unknown; note?: unknown },
): Promise<void> {
  const rateLimitPerMinute = parseRateLimit(input.rateLimitPerMinute);
  const note = cleanNote(input.note);
  await withSystemContext(adminDb, { organizationId: input.organizationId }, async (scoped) => {
    const updated = await updateApiKeySettings(scoped, {
      id: input.apiKeyId,
      organizationId: input.organizationId,
      rateLimitPerMinute,
      note,
    });
    if (updated === 0) {
      throw new ApiKeyDeniedError();
    }
    await insertAuditEvent(scoped, {
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: "api_key.updated",
      targetType: "api_key",
      targetId: input.apiKeyId,
      metadata: { rateLimitPerMinute, updatedBy: "platform_operator" },
    });
  });
}

export { countActiveApiKeys, listApiKeys };
