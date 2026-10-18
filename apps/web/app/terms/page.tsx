import { ContactLine, LegalDocument } from "@/components/LegalDocument";
import { legalFacts } from "@/lib/legal";
import Link from "next/link";

export const dynamic = "force-dynamic";

export const metadata = { title: "Terms of Service · Sentiment" };

export default function TermsPage() {
  const { operator, governingLaw } = legalFacts();
  return (
    <LegalDocument title="Terms of Service" current="/terms">
      <p>
        These terms are an agreement between you and {operator} (“we”, “us”) for the use of Sentiment, including the
        website, the app, the API and any related services (the “Service”). By creating an account or using the Service
        you agree to these terms, the <Link href="/privacy">Privacy Policy</Link>, the{" "}
        <Link href="/acceptable-use">Acceptable Use Policy</Link> and, if you use the API, the{" "}
        <Link href="/api-terms">API Terms</Link>. If you use the Service for a company, you agree for that company and
        confirm you can bind it.
      </p>

      <h2>1. Who can use Sentiment</h2>
      <p>
        You must be at least 18 years old, or the age of majority where you live, and able to form a binding contract.
        You may not use the Service if the law prohibits it or if we have previously closed your account.
      </p>

      <h2>2. Accounts and workspaces</h2>
      <p>
        You need an account to use most of the Service. Give accurate information, keep your password and API keys
        secret, and tell us promptly if you think someone else has access. You are responsible for activity in your
        account and in workspaces you own, including activity by team members you invite.
      </p>

      <h2>3. What Sentiment provides</h2>
      <p>
        Sentiment collects public discussion about trading card products, links it to specific cards, sets, sealed and
        graded products, compares creators’ past calls with later market prices, and shows buy and sell readings, scores,
        chart readings, accuracy figures and related information (together, “Insights”).
      </p>
      <p>
        <strong>Insights are information, not advice.</strong> They are generated automatically from incomplete
        third-party data and statistical models that can be wrong, stale or uncalibrated. Nothing in the Service is
        investment, financial, tax or legal advice, or a recommendation to buy, sell or hold any item. Collectible prices
        are volatile and you can lose money. You are solely responsible for your decisions and should do your own research.
      </p>

      <h2>4. Third-party content and data</h2>
      <p>
        The Service shows and links to content made by others, such as videos, posts and websites, and uses market data
        from providers such as TCG Card Central and the marketplaces it draws on. We do not control, endorse or guarantee
        third-party content or data, and a creator’s appearance in Sentiment, including their accuracy score, is not an
        endorsement by us or of us. Your use of third-party sites is governed by their terms.
      </p>
      <p>
        Sentiment is an independent service. It is not affiliated with, sponsored or endorsed by The Pokémon Company,
        Nintendo, Bandai, Konami, Shueisha, Toei Animation or any other rights holder. Game, card and product names are
        trademarks of their owners and are used only to identify the items discussed.
      </p>

      <h2>5. Plans, billing and cancellation</h2>
      <p>
        Some features need a paid plan. Plan features and prices are shown on the Billing page before you subscribe.
        Payments are processed by Stripe. Paid plans renew automatically each billing period until cancelled. You can
        cancel at any time from the Billing page; cancellation takes effect at the end of the current period and you keep
        access until then. Except where the law requires otherwise, fees already paid are not refundable.
      </p>
      <p>
        We may change prices or plan features with at least 30 days’ notice; a price change applies from your next
        renewal after the notice. If a payment fails, we may move your workspace to the Free plan. Your data is kept when
        that happens.
      </p>

      <h2>6. Your content</h2>
      <p>
        You keep ownership of what you add to the Service, such as topics, watchlists, creator list choices, notes and
        feedback (“Your Content”). You give us a worldwide, non-exclusive licence to host, process and display Your
        Content only as needed to run, secure and improve the Service. If you send us suggestions or feedback, we may use
        them without obligation to you.
      </p>

      <h2>7. Our rights</h2>
      <p>
        The Service, including its software, design, scores, models and compiled data, belongs to us and our licensors.
        While you follow these terms, we give you a limited, non-exclusive, non-transferable licence to use the Service
        for your own personal or internal business purposes. You may not copy, resell, or redistribute Insights in bulk,
        or use them to build a competing product, except as the API Terms allow.
      </p>

      <h2>8. Acceptable use and the API</h2>
      <p>
        You must follow the <Link href="/acceptable-use">Acceptable Use Policy</Link>. Use of the API is also subject to
        the <Link href="/api-terms">API Terms</Link>, including rate limits and attribution.
      </p>

      <h2>9. Suspension and termination</h2>
      <p>
        You can stop using the Service and ask us to close your workspace at any time. We may suspend or close an account
        or workspace if you break these terms, if needed to protect the Service, its users or others, or if the law
        requires it. Where reasonable we will tell you first. Sections 3, 4, 6, 7 and 10 to 14 survive termination.
      </p>

      <h2>10. Disclaimers</h2>
      <p>
        The Service is provided “as is” and “as available”. To the fullest extent the law allows, we disclaim all
        warranties, express or implied, including merchantability, fitness for a particular purpose, accuracy,
        non-infringement and uninterrupted or error-free operation.
      </p>

      <h2>11. Limitation of liability</h2>
      <p>
        To the fullest extent the law allows, we are not liable for any indirect, incidental, special, consequential or
        punitive damages, or for lost profits, trading or investment losses, lost data or loss of goodwill, arising from
        or related to the Service or Insights. Our total liability for all claims relating to the Service is limited to
        the greater of the amount you paid us in the 12 months before the claim arose and US$100. Some places do not
        allow these limits, so they may not fully apply to you.
      </p>

      <h2>12. Indemnity</h2>
      <p>
        If you use the Service for a business, that business will defend and indemnify us against third-party claims
        arising from its misuse of the Service or breach of these terms.
      </p>

      <h2>13. Changes to these terms</h2>
      <p>
        We may update these terms. If a change is material we will notify you by email or in the app at least 14 days
        before it takes effect. Continuing to use the Service after the effective date means you accept the updated
        terms.
      </p>

      <h2>14. Governing law and disputes</h2>
      <p>
        {governingLaw
          ? `These terms are governed by the laws of ${governingLaw}, without regard to conflict-of-law rules, and disputes will be resolved in the courts located there, unless the law where you live gives you the right to bring a claim locally.`
          : "These terms are governed by the laws of the place where the operator of Sentiment is established, without regard to conflict-of-law rules, unless the law where you live gives you the right to bring a claim locally."}{" "}
        Before filing a claim, please contact us so we can try to resolve it informally.
      </p>

      <h2>15. Contact</h2>
      <p>
        Questions about these terms: <ContactLine />.
      </p>
    </LegalDocument>
  );
}
