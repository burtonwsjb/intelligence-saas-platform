import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { HeaderNav } from "@/components/HeaderNav";
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
        <header className="shell-header">
          <Link className="shell-brand" href="/">
            Intelligence Platform
          </Link>
          <HeaderNav />
        </header>
        <main className="shell-main">{children}</main>
      </body>
    </html>
  );
}
