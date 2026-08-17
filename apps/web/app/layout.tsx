import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Intelligence Platform",
  description: "Standalone decision intelligence SaaS — Phase 01 shell",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="shell-header">
          <Link className="shell-brand" href="/">
            Intelligence Platform
          </Link>
          <nav className="shell-nav" aria-label="Primary">
            <Link href="/login">Log in</Link>
            <Link href="/signup">Sign up</Link>
            <Link href="/app">App</Link>
            <Link href="/admin">Admin</Link>
          </nav>
        </header>
        <main className="shell-main">{children}</main>
      </body>
    </html>
  );
}
