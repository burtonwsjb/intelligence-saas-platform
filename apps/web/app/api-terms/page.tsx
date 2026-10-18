import { ContactLine, LegalDocument } from "@/components/LegalDocument";
import Link from "next/link";

export const dynamic = "force-dynamic";

export const metadata = { title: "API Terms · Sentiment" };

export default function ApiTermsPage() {
  return (
    <LegalDocument title="API Terms" current="/api-terms">
      <p>
        These terms apply when you use the Sentiment API, including API keys and webhooks. They add to the{" "}
        <Link href="/terms">Terms of Service</Link> and the <Link href="/acceptable-use">Acceptable Use Policy</Link>; if
        they conflict, these API Terms apply to API use.
      </p>

      <h2>1. API keys</h2>
      <p>
        API keys belong to your workspace and are shown once when created. Keep them secret, store them on servers rather
        than in browsers or apps that others can inspect, give each key only the scopes it needs, and revoke any key you
        think is exposed. You are responsible for all requests made with your keys.
      </p>

      <h2>2. Limits</h2>
      <p>
        Each plan includes a monthly request allowance, shown on your Billing and Usage pages, and the API also applies
        short-term rate limits to protect the Service. Requests over a limit receive an HTTP 429 response. Do not spread traffic across keys or accounts to get around
        limits. If you need more, upgrade or contact us.
      </p>

      <h2>3. Using the data</h2>
      <ul>
        <li>
          You may use API responses inside your own products and show them to your users, for example a sentiment reading
          next to a card.
        </li>
        <li>
          Where you show Insights to others, credit “Sentiment”, show how recent the data is where the API provides it,
          and do not present Insights as guarantees or as investment advice.
        </li>
        <li>
          You may cache responses for up to 24 hours to improve performance. Do not store responses to build a database
          that substitutes for the API, and do not resell or redistribute API data in bulk.
        </li>
        <li>
          Some data comes from third parties, such as market prices. You must also follow any restrictions we pass on from
          those providers.
        </li>
      </ul>

      <h2>4. Webhooks</h2>
      <p>
        Webhook endpoints must use HTTPS and be systems you own or control. Each delivery is signed in the <code>x-isp-signature</code> header; verify it
        before trusting the payload. We may pause a webhook that keeps failing.
      </p>

      <h2>5. Changes to the API</h2>
      <p>
        The API is versioned (for example <code>/v1</code>). We may add fields and endpoints at any time, so build clients
        that ignore fields they do not recognise. For breaking changes to a version we aim to give at least 30 days’
        notice, unless a faster change is needed for security or legal reasons.
      </p>

      <h2>6. Suspension</h2>
      <p>
        We may throttle, suspend or revoke API access that breaks these terms, puts the Service at risk or creates
        unusual load. Where reasonable we will contact you first.
      </p>

      <h2>7. No warranty</h2>
      <p>
        The API is provided “as is”, with the disclaimers and limits of liability in the Terms of Service. Unless we agree
        otherwise in writing, there is no uptime commitment.
      </p>

      <h2>8. Contact</h2>
      <p>
        API questions and limit increases: <ContactLine />.
      </p>
    </LegalDocument>
  );
}
