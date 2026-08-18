export function isProtectedPath(pathname: string): boolean {
  return pathname === "/app" || pathname.startsWith("/app/") || pathname === "/onboarding";
}
