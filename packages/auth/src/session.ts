export class AuthRequiredError extends Error {
  constructor() {
    super("Authentication required.");
    this.name = "AuthRequiredError";
  }
}

export class OrganizationRequiredError extends Error {
  constructor() {
    super("An organization is required.");
    this.name = "OrganizationRequiredError";
  }
}

export class OrganizationAccessError extends Error {
  constructor() {
    super("You are not a member of that organization.");
    this.name = "OrganizationAccessError";
  }
}

export type SessionLike = {
  session: {
    userId: string;
    activeOrganizationId?: string | null;
  };
  user: {
    id: string;
  };
  member?: {
    organizationId: string;
    role: string;
  } | null;
};

export function requireSession<T extends SessionLike | null>(
  session: T,
): asserts session is NonNullable<T> {
  if (!session) {
    throw new AuthRequiredError();
  }
}

export function requireActiveOrganization<T extends SessionLike>(
  session: T,
): string {
  const organizationId = session.session.activeOrganizationId;
  if (!organizationId) {
    throw new OrganizationRequiredError();
  }
  return organizationId;
}
