export function isProtectedPath(pathname: string): boolean {
  return (
    pathname === "/app" ||
    pathname.startsWith("/app/") ||
    pathname === "/onboarding" ||
    pathname === "/admin" ||
    pathname.startsWith("/admin/")
  );
}
