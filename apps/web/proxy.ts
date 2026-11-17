import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { canonicalRedirectUrl } from "./lib/canonical-host";
import { isProtectedPath } from "./lib/protected-paths";
import { safeInternalPath } from "./lib/security-headers";

export function proxy(request: NextRequest) {
  // Railway forwards the custom domain in Host; prefer x-forwarded-host when a proxy sets it.
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? request.nextUrl.host;
  const canonical = canonicalRedirectUrl(host, request.nextUrl.pathname, request.nextUrl.search);
  if (canonical) {
    return NextResponse.redirect(canonical, 308);
  }

  if (!isProtectedPath(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const sessionCookie = getSessionCookie(request);
  if (!sessionCookie) {
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
  // Every page and route (so old-domain links redirect), but not Next's static build files.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
