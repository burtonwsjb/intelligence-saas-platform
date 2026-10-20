import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { HeaderNav } from "@/components/HeaderNav";
import { SKIP_LINK_HREF } from "@/lib/a11y";
import "./globals.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sentiment",
  description: "Buy and sell sentiment for trading cards and sealed products",
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
            Sentiment
          </Link>
          <HeaderNav />
        </header>
        <main id="main" className="shell-main">
          {children}
        </main>
        <footer className="shell-footer">
          <nav className="shell-nav" aria-label="Legal">
            <Link href="/terms">Terms</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/acceptable-use">Acceptable use</Link>
            <Link href="/api-terms">API terms</Link>
          </nav>
          <p className="shell-legal-note">
            Card images and names belong to their owners, including The Pokémon Company, Nintendo, Bandai,
            Shueisha, Toei Animation and Konami. Sentiment is not affiliated with or endorsed by them.
          </p>
        </footer>
      </body>
    </html>
  );
}
