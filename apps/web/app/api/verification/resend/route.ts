import {
  getVerificationResendLimiter,
  resendVerificationEmail,
} from "@isp/auth";
import { getAuth, isAuthConfigError } from "@/lib/auth";
import { handleVerificationResendRequest } from "@/lib/verification-resend";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleVerificationResendRequest(request, {
    getAuth,
    limiter: getVerificationResendLimiter(),
    send: resendVerificationEmail,
    env: process.env,
    isAuthConfigError,
  });
}
