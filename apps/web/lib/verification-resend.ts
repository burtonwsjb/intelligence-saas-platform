import {
  clientIpFromHeaders,
  resendVerificationEmail,
  type VerificationResendLimiter,
  type VerificationResendResult,
} from "@isp/auth";
import { logAuthConfigError } from "./auth-diagnostics";

export function isSendVerificationEmailPath(pathname: string): boolean {
  return pathname.endsWith("/send-verification-email");
}

export function isAllowedVerificationOrigin(
  origin: string | null,
  allowedOrigins: string[],
): boolean {
  if (!origin || allowedOrigins.length === 0) {
    return true;
  }
  try {
    const requestOrigin = new URL(origin).origin;
    return allowedOrigins.some((value) => {
      try {
        return new URL(value).origin === requestOrigin;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export function verificationResendJson(result: VerificationResendResult): Response {
  return Response.json({ ok: result.outcome === "sent" });
}

export type VerificationResendRequestDeps = {
  getAuth: () => Parameters<typeof resendVerificationEmail>[0]["auth"];
  limiter: VerificationResendLimiter;
  send: typeof resendVerificationEmail;
  env: NodeJS.ProcessEnv;
  isAuthConfigError: (error: unknown) => boolean;
};

function allowedOrigins(env: NodeJS.ProcessEnv): string[] {
  return [env.APP_URL, env.BETTER_AUTH_URL].filter(
    (value): value is string => Boolean(value?.trim()),
  );
}

export async function handleVerificationResendRequest(
  request: Request,
  deps: VerificationResendRequestDeps,
): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ ok: false }, { status: 405 });
  }

  try {
    const origin = request.headers.get("origin");
    if (!isAllowedVerificationOrigin(origin, allowedOrigins(deps.env))) {
      return verificationResendJson({ outcome: "unavailable" });
    }

    const auth = deps.getAuth();
    const body: unknown = await request.json().catch(() => null);
    const email =
      body && typeof body === "object" && body !== null && "email" in body
        ? (body as { email: unknown }).email
        : null;

    const result = await deps.send({
      auth,
      email,
      ip: clientIpFromHeaders(request.headers),
      limiter: deps.limiter,
    });
    return verificationResendJson(result);
  } catch (error) {
    if (deps.isAuthConfigError(error)) {
      logAuthConfigError(error);
      return Response.json(
        { error: "Authentication is not configured." },
        { status: 503 },
      );
    }
    return verificationResendJson({ outcome: "unavailable" });
  }
}
