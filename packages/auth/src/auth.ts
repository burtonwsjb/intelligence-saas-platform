import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { organization } from "better-auth/plugins";
import {
  account,
  invitation,
  member,
  organization as organizationTable,
  session,
  user,
  verification,
  type Database,
} from "@isp/db";
import {
  createEmailDelivery,
  type EmailDelivery,
} from "./email.js";
import { ac, organizationRoles } from "./permissions.js";
import { ensureTenantRow } from "./tenant.js";

export type AuthEnv = {
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  APP_URL: string;
  NODE_ENV: string;
  AUTH_EMAIL_MODE?: string;
};

export class MissingAuthSecretError extends Error {
  constructor() {
    super(
      "BETTER_AUTH_SECRET is missing or too short. Generate a local secret of at least 32 characters and keep it out of git.",
    );
    this.name = "MissingAuthSecretError";
  }
}

export function isMissingAuthSecretError(
  error: unknown,
): error is MissingAuthSecretError {
  return error instanceof MissingAuthSecretError;
}

export function requireAuthSecret(secret: string | undefined): string {
  const value = secret?.trim();
  if (!value || value.length < 32) {
    throw new MissingAuthSecretError();
  }
  return value;
}

export type Auth = ReturnType<typeof createAuth>;

export function createAuth(options: {
  db: Database;
  env: AuthEnv;
  emailDelivery?: EmailDelivery;
  extraPlugins?: Parameters<typeof betterAuth>[0]["plugins"];
}) {
  const secret = requireAuthSecret(options.env.BETTER_AUTH_SECRET);
  const emailDelivery =
    options.emailDelivery ??
    createEmailDelivery({
      nodeEnv: options.env.NODE_ENV,
      mode: options.env.AUTH_EMAIL_MODE,
    });

  return betterAuth({
    secret,
    baseURL: options.env.BETTER_AUTH_URL,
    trustedOrigins: [options.env.APP_URL],
    database: drizzleAdapter(options.db, {
      provider: "pg",
      schema: {
        user,
        session,
        account,
        verification,
        organization: organizationTable,
        member,
        invitation,
      },
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 8,
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user: authUser, url }) => {
        await emailDelivery.send({ to: authUser.email, url });
      },
    },
    session: {
      cookieCache: {
        enabled: false,
      },
    },
    advanced: {
      useSecureCookies: options.env.NODE_ENV === "production",
      disableCSRFCheck: false,
    },
    plugins: [
      organization({
        ac,
        roles: organizationRoles,
        creatorRole: "owner",
        allowUserToCreateOrganization: true,
        organizationHooks: {
          afterCreateOrganization: async ({ organization: org, user: owner }) => {
            await ensureTenantRow(options.db, {
              organizationId: org.id,
              createdByUserId: owner.id,
            });
          },
        },
      }),
      ...(options.extraPlugins ?? []),
    ],
  });
}
