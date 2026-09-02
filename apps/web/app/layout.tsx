import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { HeaderNav } from "@/components/HeaderNav";
import { SKIP_LINK_HREF } from "@/lib/a11y";
import "./globals.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Intelligence Platform",
  description: "Standalone decision intelligence SaaS",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href={SKIP_LINK_HREF}>
          Skip to content
        </a>
        <header className="shell-header">
          <Link className="shell-brand" href="/">
            Intelligence Platform
          </Link>
          <HeaderNav />
        </header>
        <main id="main" className="shell-main">
          {children}
        </main>
        <footer className="shell-header">
          <nav className="shell-nav" aria-label="Legal">
            <Link href="/terms">Terms</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/acceptable-use">Acceptable use</Link>
            <Link href="/api-terms">API terms</Link>
          </nav>
        </footer>
      </body>
    </html>
  );
}
