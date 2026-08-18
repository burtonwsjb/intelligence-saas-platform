export class MissingDatabaseUrlError extends Error {
  constructor() {
    super(
      "DATABASE_URL is not set. Database-dependent features cannot run until a Postgres connection string is configured.",
    );
    this.name = "MissingDatabaseUrlError";
  }
}

export function requireDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    throw new MissingDatabaseUrlError();
  }
  return url;
}

export function isMissingDatabaseUrlError(
  error: unknown,
): error is MissingDatabaseUrlError {
  return error instanceof MissingDatabaseUrlError;
}
