export const INVITABLE_ROLES = [
  "admin",
  "developer",
  "analyst",
  "marketing",
  "billing",
  "viewer",
] as const;

export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export function isInvitableRole(value: string): value is InvitableRole {
  return (INVITABLE_ROLES as readonly string[]).includes(value);
}

export function assertCanManageTeam(canManageMembers: boolean): void {
  if (!canManageMembers) {
    throw new Error("Permission denied.");
  }
}

export function assertNotLastOwner(input: { targetRole: string; ownerCount: number; removing: boolean }): void {
  if (input.targetRole === "owner" && input.ownerCount <= 1 && input.removing) {
    throw new Error("The last owner cannot be removed.");
  }
}
