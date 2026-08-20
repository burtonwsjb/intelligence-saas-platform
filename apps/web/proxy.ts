import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { isProtectedPath } from "./lib/protected-paths";

export function proxy(request: NextRequest) {
  const sessionCookie = getSessionCookie(request);

  if (isProtectedPath(request.nextUrl.pathname) && !sessionCookie) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/app", "/app/:path*", "/onboarding", "/admin", "/admin/:path*"],
};
