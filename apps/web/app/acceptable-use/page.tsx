import { ContactLine, LegalDocument } from "@/components/LegalDocument";

export const dynamic = "force-dynamic";

export const metadata = { title: "Acceptable Use · Sentiment" };

export default function AcceptableUsePage() {
  return (
    <LegalDocument title="Acceptable Use Policy" current="/acceptable-use">
      <p>
        This policy applies to everyone who uses Sentiment, through the website, the app or the API. It is part of the
        Terms of Service. We want Sentiment to stay fair and useful for collectors, so please don’t misuse it.
      </p>

      <h2>Do not use Sentiment to</h2>
      <ul>
        <li>break any law, or help anyone else do so;</li>
        <li>
          manipulate a market or mislead people, for example by coordinating buyouts or “pump” campaigns, or by
          presenting Insights as guarantees or as personalised investment advice;
        </li>
        <li>harass, threaten, dox or defame anyone, including creators shown in Sentiment;</li>
        <li>impersonate a person or organisation, or misrepresent your connection with Sentiment;</li>
        <li>
          scrape, crawl or bulk-download the website, or copy, resell or redistribute Insights or compiled data, except
          through the API as the API Terms allow;
        </li>
        <li>use Insights or the API to build a product that competes with Sentiment;</li>
        <li>
          share accounts or API keys outside your workspace, create accounts automatically, or get around plan limits,
          rate limits, quotas or access controls;
        </li>
        <li>access, or try to access, another workspace’s data or any part of the Service you are not allowed to use;</li>
        <li>
          probe, scan or test the Service for vulnerabilities, or interfere with or overload it, unless we have agreed to
          it in writing;
        </li>
        <li>upload malware or any content that infringes someone else’s rights;</li>
        <li>point webhooks at systems you do not own or control.</li>
      </ul>

      <h2>Reporting problems</h2>
      <p>
        If you find a security issue, report it to <ContactLine /> and give us reasonable time to fix it before
        disclosing it. Good-faith reports that follow this policy will not be treated as a violation.
      </p>

      <h2>Enforcement</h2>
      <p>
        If we believe this policy has been broken we may remove content, limit or suspend access, revoke API keys, or
        close the account, and we may report illegal activity to the authorities. Where reasonable we will tell you what
        happened and give you a chance to respond.
      </p>
    </LegalDocument>
  );
}
