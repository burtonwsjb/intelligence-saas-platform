import { toNextJsHandler } from "better-auth/next-js";
import { consumeBetaInvite } from "@isp/db";
import {
  getVerificationResendLimiter,
  resendVerificationEmail,
} from "@isp/auth";
import { logAuthConfigError } from "@/lib/auth-diagnostics";
import { publicAuthRouteError } from "@/lib/auth-errors";
import { getAuth, getDb, isAuthConfigError } from "@/lib/auth";
import { MemoryWindowLimiter, clientIpFromRequestHeaders } from "@isp/shared";
import {
  handleVerificationResendRequest,
  isSendVerificationEmailPath,
} from "@/lib/verification-resend";

export const runtime = "nodejs";

const authLimiter = new MemoryWindowLimiter({ windowMs: 60_000 });
const AUTH_SENSITIVE = /\/(sign-in|sign-up|forget-password|request-password-reset)(\/|$)/i;

function unavailable(error: unknown) {
  logAuthConfigError(error);
  return Response.json(
    { error: "Authentication is not configured." },
    { status: 503 },
  );
}

export async function GET(request: Request) {
  try {
    return toNextJsHandler(getAuth()).GET(request);
  } catch (error) {
    if (isAuthConfigError(error)) {
      return unavailable(error);
    }
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    const url = new URL(request.url);
    if (AUTH_SENSITIVE.test(url.pathname)) {
      const ip = clientIpFromRequestHeaders(request.headers);
      if (!authLimiter.consume(`auth:${ip}`, 20)) {
        return Response.json({ error: publicAuthRouteError() }, { status: 429 });
      }
    }
    if (isSendVerificationEmailPath(url.pathname)) {
      return handleVerificationResendRequest(request, {
        getAuth,
        limiter: getVerificationResendLimiter(),
        send: resendVerificationEmail,
        env: process.env,
        isAuthConfigError,
      });
    }
    if (process.env.BETA_INVITE_ONLY === "true") {
      if (url.pathname.endsWith("/sign-up/email")) {
        const token = request.headers.get("x-beta-invite") ?? "";
        const copy = await request.clone().json().catch(() => ({}));
        const email = typeof copy === "object" && copy && "email" in copy ? String(copy.email) : null;
        await consumeBetaInvite(getDb(), { token, email });
      }
    }
    return toNextJsHandler(getAuth()).POST(request);
  } catch (error) {
    if (isAuthConfigError(error)) {
      return unavailable(error);
    }
    if (process.env.BETA_INVITE_ONLY === "true") {
      return Response.json({ error: publicAuthRouteError() }, { status: 403 });
    }
    throw error;
  }
}
