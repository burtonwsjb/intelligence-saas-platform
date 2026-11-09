"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** True on signed-in surfaces, which bring their own sidebar and top bar. */
export function isAppSurface(pathname: string): boolean {
  return /^\/(app|admin)(\/|$)/.test(pathname);
}

/** Renders the public header or footer everywhere except the app and admin consoles. */
export function MarketingChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  return isAppSurface(pathname) ? null : <>{children}</>;
}
