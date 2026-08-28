import { eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { platformAdmins } from "../schema/platform.js";
import { user } from "../schema/auth.js";
import { SECRET_SCAN } from "./catalog.js";
import { grantPlatformAdmin } from "./grants.js";

export type PlatformAdminGrantErrorCode =
  | "invalid_args"
  | "user_not_found"
  | "email_unverified";

export class PlatformAdminGrantError extends Error {
  readonly code: PlatformAdminGrantErrorCode;

  constructor(message: string, code: PlatformAdminGrantErrorCode) {
    super(message);
    this.name = "PlatformAdminGrantError";
    this.code = code;
  }
}

export type GrantPlatformAdminByEmailInput = {
  email: string;
  note?: string | null;
};

export type GrantPlatformAdminByEmailResult = {
  status: "granted" | "already_granted";
  userId: string;
  emailVerified: true;
};

export type ParsedGrantPlatformAdminArgs = {
  email: string;
  note: string | null;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_NOTE = "cli.grant_platform_admin";
const CONNECTION_STRING = /(?:postgres(?:ql)?|redis[s]?):\/\/[^\s"'\\]+/gi;
const PASSWORD_ASSIGNMENT = /password\s*[=:]\s*\S+/gi;

export function normalizeGrantEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    return null;
  }
  return email;
}

export function parseGrantPlatformAdminArgs(argv: string[]): ParsedGrantPlatformAdminArgs {
  const args = argv.filter((part) => part !== "--");
  let email: string | undefined;
  let note: string | null = DEFAULT_NOTE;

  for (let index = 0; index < args.length; index += 1) {
    const part = args[index]!;
    if (part === "--email") {
      email = args[index + 1];
      index += 1;
      continue;
    }
    if (part.startsWith("--email=")) {
      email = part.slice("--email=".length);
      continue;
    }
    if (part === "--note") {
      note = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (part.startsWith("--note=")) {
      note = part.slice("--note=".length);
      continue;
    }
    if (part.startsWith("-")) {
      throw new PlatformAdminGrantError("Unknown argument.", "invalid_args");
    }
    if (!email) {
      email = part;
    }
  }

  const normalized = email ? normalizeGrantEmail(email) : null;
  if (!normalized) {
    throw new PlatformAdminGrantError("A valid email argument is required.", "invalid_args");
  }
  if (note && (note.length > 200 || SECRET_SCAN.test(note))) {
    throw new PlatformAdminGrantError("Note is invalid.", "invalid_args");
  }
  return { email: normalized, note };
}

export function sanitizePlatformAdminCliMessage(value: string): string {
  return value
    .replace(CONNECTION_STRING, "[redacted]")
    .replace(PASSWORD_ASSIGNMENT, "password=[redacted]")
    .replace(/\b(?:sk_live_|sk_test_|whsec_|re_)[A-Za-z0-9]+/g, "[redacted]");
}

export function formatGrantPlatformAdminReport(result: GrantPlatformAdminByEmailResult): string {
  return [
    `status: ${result.status}`,
    `user_id: ${result.userId}`,
    "email_verified: true",
  ].join("\n");
}

export async function grantPlatformAdminByEmail(
  db: Database,
  input: GrantPlatformAdminByEmailInput,
): Promise<GrantPlatformAdminByEmailResult> {
  const email = normalizeGrantEmail(input.email);
  if (!email) {
    throw new PlatformAdminGrantError("A valid email argument is required.", "invalid_args");
  }
  if (input.note && (input.note.length > 200 || SECRET_SCAN.test(input.note))) {
    throw new PlatformAdminGrantError("Note is invalid.", "invalid_args");
  }

  const [found] = await db
    .select({
      id: user.id,
      emailVerified: user.emailVerified,
    })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);

  if (!found) {
    throw new PlatformAdminGrantError("User not found.", "user_not_found");
  }
  if (!found.emailVerified) {
    throw new PlatformAdminGrantError("Email is not verified.", "email_unverified");
  }

  const [existing] = await db
    .select({ userId: platformAdmins.userId })
    .from(platformAdmins)
    .where(eq(platformAdmins.userId, found.id))
    .limit(1);

  await grantPlatformAdmin(db, {
    userId: found.id,
    note: input.note ?? DEFAULT_NOTE,
  });

  return {
    status: existing ? "already_granted" : "granted",
    userId: found.id,
    emailVerified: true,
  };
}
