import { LEGAL_EFFECTIVE_DATE, legalFacts } from "@/lib/legal";
import Link from "next/link";
import type { ReactNode } from "react";

const DOCUMENTS = [
  { href: "/terms", label: "Terms of Service" },
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/acceptable-use", label: "Acceptable Use" },
  { href: "/api-terms", label: "API Terms" },
];

/** How to reach the operator: the contact email when configured, otherwise the in-app feedback page. */
export function ContactLine() {
  const { contactEmail } = legalFacts();
  return contactEmail ? (
    <a href={`mailto:${contactEmail}`}>{contactEmail}</a>
  ) : (
    <>
      the <Link href="/app/feedback">Feedback page</Link> in your account
    </>
  );
}

export function LegalDocument({ title, current, children }: { title: string; current: string; children: ReactNode }) {
  return (
    <article className="legal">
      <nav className="legal-nav" aria-label="Legal documents">
        {DOCUMENTS.map((doc) => (
          <Link key={doc.href} href={doc.href} aria-current={doc.href === current ? "page" : undefined}>
            {doc.label}
          </Link>
        ))}
      </nav>
      <h1>{title}</h1>
      <p className="subtle">Effective {LEGAL_EFFECTIVE_DATE}</p>
      {children}
    </article>
  );
}
