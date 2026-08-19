import { describe, expect, it } from "vitest";
import {
  UnknownRoleError,
  PermissionDeniedError,
  hasPermission,
  requirePermission,
  resolveOrganizationRole,
} from "./rbac.js";

describe("RBAC", () => {
  it("maps known roles to server-side permissions", () => {
    expect(hasPermission("owner", "canAdminTenant")).toBe(true);
    expect(hasPermission("admin", "canManageMembers")).toBe(true);
    expect(hasPermission("developer", "canManageApiKeys")).toBe(true);
    expect(hasPermission("analyst", "canViewAnalytics")).toBe(true);
    expect(hasPermission("marketing", "canManageContent")).toBe(true);
    expect(hasPermission("billing", "canManageBilling")).toBe(true);
    expect(hasPermission("viewer", "canViewAnalytics")).toBe(true);
  });

  it("denies permissions the role does not have", () => {
    expect(hasPermission("viewer", "canAdminTenant")).toBe(false);
    expect(hasPermission("analyst", "canManageBilling")).toBe(false);
    expect(hasPermission("billing", "canManageMembers")).toBe(false);
    expect(() => requirePermission("viewer", "canManageMembers")).toThrow(
      PermissionDeniedError,
    );
  });

  it("fails closed for unknown roles", () => {
    expect(hasPermission("superuser", "canViewAnalytics")).toBe(false);
    expect(hasPermission("", "canViewAnalytics")).toBe(false);
    expect(hasPermission(null, "canViewAnalytics")).toBe(false);
    expect(() => resolveOrganizationRole("platform-admin")).toThrow(UnknownRoleError);
    expect(() => requirePermission("not-a-role", "canViewAnalytics")).toThrow(
      UnknownRoleError,
    );
  });

  it("does not treat platform admin as a tenant role", () => {
    expect(hasPermission("platform_admin", "canAdminTenant")).toBe(false);
    expect(() => resolveOrganizationRole("platform_admin")).toThrow(UnknownRoleError);
  });
});
