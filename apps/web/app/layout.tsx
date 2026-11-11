import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { HeaderNav } from "@/components/HeaderNav";
import { BrandMark } from "@/components/Icon";
import { MarketingChrome } from "@/components/MarketingChrome";
import { SKIP_LINK_HREF } from "@/lib/a11y";
import { CANONICAL_ORIGIN } from "@/lib/canonical-host";
import "./globals.css";

export const dynamic = "force-dynamic";

const DESCRIPTION = "Buy and sell sentiment for trading cards and sealed products";

/** Absolute links (Open Graph, canonical) use APP_URL, falling back to tcgsentiment.com. */
function siteOrigin(): URL {
  try {
    return new URL(process.env.APP_URL?.trim() || CANONICAL_ORIGIN);
  } catch {
    return new URL(CANONICAL_ORIGIN);
  }
}

export function generateMetadata(): Metadata {
  return {
    metadataBase: siteOrigin(),
    title: "Sentiment",
    description: DESCRIPTION,
    applicationName: "Sentiment",
    openGraph: { type: "website", siteName: "Sentiment", title: "Sentiment", description: DESCRIPTION, url: "/" },
  };
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href={SKIP_LINK_HREF}>
          Skip to content
        </a>
        <MarketingChrome>
          <header className="shell-header">
            <Link className="shell-brand" href="/">
              <BrandMark size={28} />
              Sentiment
            </Link>
            <HeaderNav />
          </header>
        </MarketingChrome>
        <main id="main" className="shell-main">
          {children}
        </main>
        <MarketingChrome>
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
        </MarketingChrome>
      </body>
    </html>
  );
}
