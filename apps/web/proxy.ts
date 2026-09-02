import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { isProtectedPath } from "./lib/protected-paths";
import { safeInternalPath } from "./lib/security-headers";

export function proxy(request: NextRequest) {
  const sessionCookie = getSessionCookie(request);

  if (isProtectedPath(request.nextUrl.pathname) && !sessionCookie) {
    const login = new URL("/login", request.url);
    const next = safeInternalPath(request.nextUrl.pathname);
    if (next) {
      login.searchParams.set("next", next);
    }
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/app", "/app/:path*", "/onboarding", "/admin", "/admin/:path*"],
};
