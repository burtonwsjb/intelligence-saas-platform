import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";

const statement = {
  ...defaultStatements,
  tenant: ["read", "update", "suspend"],
} as const;

export const ac = createAccessControl(statement);

export const owner = ac.newRole({
  ...ownerAc.statements,
  tenant: ["read", "update", "suspend"],
});

export const admin = ac.newRole({
  ...adminAc.statements,
  tenant: ["read", "update"],
});

export const developer = ac.newRole({
  ...memberAc.statements,
  tenant: ["read"],
});

export const analyst = ac.newRole({
  ...memberAc.statements,
  tenant: ["read"],
});

export const marketing = ac.newRole({
  ...memberAc.statements,
  tenant: ["read"],
});

export const billing = ac.newRole({
  ...memberAc.statements,
  tenant: ["read"],
});

export const viewer = ac.newRole({
  tenant: ["read"],
});

export const organizationRoles = {
  owner,
  admin,
  developer,
  analyst,
  marketing,
  billing,
  viewer,
} as const;

export type OrganizationRoleName = keyof typeof organizationRoles;
