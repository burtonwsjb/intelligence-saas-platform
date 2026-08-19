import { organizationRoles, type OrganizationRoleName } from "./permissions.js";

export const PERMISSIONS = [
  "canAdminTenant",
  "canManageMembers",
  "canManageApiKeys",
  "canViewAnalytics",
  "canManageBilling",
  "canManageContent",
] as const;

export type PermissionName = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<OrganizationRoleName, readonly PermissionName[]> = {
  owner: PERMISSIONS,
  admin: [
    "canManageMembers",
    "canManageApiKeys",
    "canViewAnalytics",
    "canManageContent",
  ],
  developer: ["canManageApiKeys", "canViewAnalytics"],
  analyst: ["canViewAnalytics"],
  marketing: ["canManageContent", "canViewAnalytics"],
  billing: ["canManageBilling", "canViewAnalytics"],
  viewer: ["canViewAnalytics"],
};

export class UnknownRoleError extends Error {
  constructor() {
    super("Unknown organization role.");
    this.name = "UnknownRoleError";
  }
}

export class PermissionDeniedError extends Error {
  constructor() {
    super("Permission denied.");
    this.name = "PermissionDeniedError";
  }
}

export function parseOrganizationRoles(role: string | null | undefined): string[] {
  if (!role) {
    return [];
  }
  return role
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function resolveOrganizationRole(
  role: string | null | undefined,
): OrganizationRoleName {
  const known = parseOrganizationRoles(role).filter(
    (value): value is OrganizationRoleName => value in organizationRoles,
  );
  if (known.length === 0) {
    throw new UnknownRoleError();
  }
  return known[0]!;
}

export function hasPermission(
  role: string | null | undefined,
  permission: PermissionName,
): boolean {
  const known = parseOrganizationRoles(role).filter(
    (value): value is OrganizationRoleName => value in organizationRoles,
  );
  if (known.length === 0) {
    return false;
  }
  return known.some((value) => ROLE_PERMISSIONS[value].includes(permission));
}

export function requirePermission(
  role: string | null | undefined,
  permission: PermissionName,
): void {
  if (!hasPermission(role, permission)) {
    if (parseOrganizationRoles(role).every((value) => !(value in organizationRoles))) {
      throw new UnknownRoleError();
    }
    throw new PermissionDeniedError();
  }
}
