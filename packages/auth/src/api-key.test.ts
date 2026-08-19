import { beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionDeniedError } from "./rbac.js";
import {
  ApiKeyDeniedError,
  UnknownScopeError,
  createTenantApiKey,
  generateApiKeySecret,
  hasScope,
  hashApiKeySecret,
  parsePresentedApiKey,
  parseScopes,
  revokeTenantApiKey,
  verifyPresentedApiKey,
} from "./api-key.js";
import type { Database } from "@isp/db";

const pepper = "phase04-test-pepper-value";
const insertApiKey = vi.fn();
const insertAuditEvent = vi.fn();
const lookupApiKeyByPrefix = vi.fn();
const revokeApiKey = vi.fn();

vi.mock("@isp/db", () => ({
  insertApiKey: (...args: unknown[]) => insertApiKey(...args),
  insertAuditEvent: (...args: unknown[]) => insertAuditEvent(...args),
  lookupApiKeyByPrefix: (...args: unknown[]) => lookupApiKeyByPrefix(...args),
  revokeApiKey: (...args: unknown[]) => revokeApiKey(...args),
  countActiveApiKeys: vi.fn(),
  listApiKeys: vi.fn(),
}));

const db = {} as Database;

describe("API key format and scopes", () => {
  it("hashes secrets and never treats the full key as the prefix", () => {
    const generated = generateApiKeySecret(pepper);
    expect(generated.fullKey.startsWith("isp_test_")).toBe(true);
    expect(generated.secretHash).not.toContain(generated.fullKey);
    expect(generated.secretHash).toBe(hashApiKeySecret(generated.fullKey, pepper));
    expect(parsePresentedApiKey(generated.fullKey)?.prefix).toBe(generated.prefix);
    expect(parsePresentedApiKey("sk_live_not_a_key")).toBeNull();
  });

  it("fails closed for unknown scopes", () => {
    expect(parseScopes(["ingest:write", "decisions:read"])).toEqual([
      "ingest:write",
      "decisions:read",
    ]);
    expect(parseScopes(["cards:read", "opportunities:read"])).toEqual([
      "cards:read",
      "opportunities:read",
    ]);
    expect(() => parseScopes(["content:read"])).toThrow(UnknownScopeError);
    expect(() => parseScopes(["not:a-scope"])).toThrow(UnknownScopeError);
    expect(hasScope(["ingest:write"], "decisions:read")).toBe(false);
    expect(hasScope(["ingest:write"], "not:a-scope")).toBe(false);
  });
});

describe("API key RBAC", () => {
  beforeEach(() => {
    insertApiKey.mockReset();
    insertAuditEvent.mockReset();
    lookupApiKeyByPrefix.mockReset();
    revokeApiKey.mockReset();
  });

  it("does not let billing, viewer, analyst, or marketing manage keys", async () => {
    const { requirePermission } = await import("./rbac.js");
    expect(() => requirePermission("billing", "canManageApiKeys")).toThrow(
      PermissionDeniedError,
    );
    expect(() => requirePermission("viewer", "canManageApiKeys")).toThrow(
      PermissionDeniedError,
    );
    expect(() => requirePermission("analyst", "canManageApiKeys")).toThrow(
      PermissionDeniedError,
    );
    expect(() => requirePermission("marketing", "canManageApiKeys")).toThrow(
      PermissionDeniedError,
    );
    expect(() => requirePermission("developer", "canManageApiKeys")).not.toThrow();
    expect(() => requirePermission("billing", "canManageBilling")).not.toThrow();
  });

  it("shows the secret once at creation and stores only the hash", async () => {
    await expect(
      createTenantApiKey(db, {
        organizationId: "org_a",
        actorUserId: "user_viewer",
        actorRole: "viewer",
        name: "blocked",
        scopes: ["decisions:read"],
        pepper,
      }),
    ).rejects.toThrow(PermissionDeniedError);
    expect(insertApiKey).not.toHaveBeenCalled();

    await expect(
      createTenantApiKey(db, {
        organizationId: "org_a",
        actorUserId: "user_billing",
        actorRole: "billing",
        name: "blocked",
        scopes: ["decisions:read"],
        pepper,
      }),
    ).rejects.toThrow(PermissionDeniedError);

    const created = await createTenantApiKey(db, {
      organizationId: "org_a",
      actorUserId: "user_dev",
      actorRole: "developer",
      name: "CI key",
      scopes: ["decisions:read"],
      pepper,
    });
    expect(created.fullKey.startsWith("isp_test_")).toBe(true);
    expect(insertApiKey).toHaveBeenCalledTimes(1);
    const stored = insertApiKey.mock.calls[0]?.[1] as {
      secretHash: string;
      prefix: string;
    };
    expect(stored.secretHash).toBe(hashApiKeySecret(created.fullKey, pepper));
    expect(stored.secretHash).not.toBe(created.fullKey);
    expect(JSON.stringify(stored)).not.toContain(created.fullKey);
  });

  it("lets a developer revoke a key and denies billing", async () => {
    revokeApiKey.mockResolvedValue(1);
    await expect(
      revokeTenantApiKey(db, {
        organizationId: "org_a",
        actorUserId: "user_billing",
        actorRole: "billing",
        apiKeyId: "key_a",
      }),
    ).rejects.toThrow(PermissionDeniedError);
    expect(revokeApiKey).not.toHaveBeenCalled();

    await revokeTenantApiKey(db, {
      organizationId: "org_a",
      actorUserId: "user_dev",
      actorRole: "developer",
      apiKeyId: "key_a",
    });
    expect(revokeApiKey).toHaveBeenCalledWith(db, {
      id: "key_a",
      organizationId: "org_a",
    });
  });

  it("denies wrong, revoked, and expired presented keys", async () => {
    const generated = generateApiKeySecret(pepper);
    lookupApiKeyByPrefix.mockResolvedValue({
      id: "key_a",
      organizationId: "org_a",
      secretHash: generated.secretHash,
      scopes: "decisions:read",
      status: "active",
      expiresAt: null,
      revokedAt: null,
    });
    await expect(
      verifyPresentedApiKey(db, `${generated.prefix}_wrongsecretvalue12`, pepper),
    ).rejects.toThrow(ApiKeyDeniedError);

    lookupApiKeyByPrefix.mockResolvedValue({
      id: "key_a",
      organizationId: "org_a",
      secretHash: generated.secretHash,
      scopes: "decisions:read",
      status: "revoked",
      expiresAt: null,
      revokedAt: new Date(),
    });
    await expect(verifyPresentedApiKey(db, generated.fullKey, pepper)).rejects.toThrow(
      ApiKeyDeniedError,
    );

    lookupApiKeyByPrefix.mockResolvedValue({
      id: "key_a",
      organizationId: "org_a",
      secretHash: generated.secretHash,
      scopes: "decisions:read",
      status: "active",
      expiresAt: new Date(Date.now() - 60_000),
      revokedAt: null,
    });
    await expect(verifyPresentedApiKey(db, generated.fullKey, pepper)).rejects.toThrow(
      ApiKeyDeniedError,
    );
  });
});
