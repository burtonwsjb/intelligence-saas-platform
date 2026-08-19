export const DB_ROLES = {
  migrate: "app_migrate",
  user: "app_user",
  worker: "app_worker",
  admin: "app_admin",
} as const;

export type DatabaseRoleName = (typeof DB_ROLES)[keyof typeof DB_ROLES];
