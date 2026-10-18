import { ContactLine, LegalDocument } from "@/components/LegalDocument";
import { legalFacts } from "@/lib/legal";

export const dynamic = "force-dynamic";

export const metadata = { title: "Privacy Policy · Sentiment" };

export default function PrivacyPage() {
  const { operator } = legalFacts();
  return (
    <LegalDocument title="Privacy Policy" current="/privacy">
      <p>
        This policy explains what personal information {operator} (“we”) collects when you use Sentiment, how we use and
        share it, and the choices you have. It also explains how we handle public information about content creators.
      </p>

      <h2>1. Information you give us</h2>
      <ul>
        <li>
          <strong>Account details:</strong> your name, email address and password. Passwords are stored only as a
          one-way hash.
        </li>
        <li>
          <strong>Workspace details:</strong> workspace name, team members you invite and their roles.
        </li>
        <li>
          <strong>What you add:</strong> topics you track, watchlists and alerts, creators you hide from your list,
          webhook addresses, and feedback or support messages.
        </li>
        <li>
          <strong>Billing:</strong> card payments are handled by Stripe. We receive and store your plan, subscription
          status and a Stripe customer reference, not your full card number.
        </li>
      </ul>

      <h2>2. Information collected automatically</h2>
      <ul>
        <li>
          <strong>Usage:</strong> pages and features used, API requests (counted for your plan’s limits) and the actions
          recorded in your workspace’s audit log.
        </li>
        <li>
          <strong>Technical data:</strong> IP address, browser and device type, and request logs used for security,
          rate limiting and troubleshooting.
        </li>
        <li>
          <strong>Cookies:</strong> we use only the cookies needed to keep you signed in and keep your session secure. We do not
          use advertising or third-party analytics cookies.
        </li>
      </ul>

      <h2>3. Public information about creators</h2>
      <p>
        To measure who makes accurate calls, Sentiment collects publicly available content about trading card products
        from sources such as YouTube, Reddit, creator websites and search results. For each item we keep the link,
        title, author or channel name, publication time, public engagement counts and a short excerpt, and we derive the
        cards mentioned, the stance taken and, later, whether the call matched market prices. We do not collect private
        messages or content behind a login.
      </p>
      <p>
        If you are a creator and want us to correct information, or to stop tracking your public content, contact us
        at <ContactLine />. We will review the request and, where we stop tracking you, keep only what we need to honour
        that request and to keep historical records accurate.
      </p>
      <p>
        Sentiment uses YouTube API Services. By using Sentiment you also agree to be bound by the{" "}
        <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener noreferrer">
          YouTube Terms of Service
        </a>
        , and information obtained through YouTube API Services is also subject to the{" "}
        <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">
          Google Privacy Policy
        </a>
        . Sentiment does not ask you to connect a YouTube or Google account; if you ever grant access, you can revoke it
        in your{" "}
        <a href="https://security.google.com/settings/security/permissions" target="_blank" rel="noopener noreferrer">
          Google security settings
        </a>
        .
      </p>

      <h2>4. How we use information</h2>
      <ul>
        <li>to provide the Service: accounts, workspaces, Insights, alerts, the API and webhooks;</li>
        <li>to send account emails such as verification, security notices, alerts you set up and billing notices;</li>
        <li>to enforce plan limits, prevent abuse and keep the Service secure;</li>
        <li>to understand and improve how the Service works;</li>
        <li>to meet legal obligations and resolve disputes.</li>
      </ul>
      <p>
        Where the law requires a legal basis, we rely on performing our contract with you, our legitimate interests in
        running a secure and accurate service (including analysing public creator content), your consent where we ask
        for it, and legal obligations.
      </p>

      <h2>5. How we share information</h2>
      <p>We do not sell personal information and we do not use it for advertising. We share it only:</p>
      <ul>
        <li>
          with service providers that run the Service for us under contract: Vercel (website hosting), Railway (API and
          background jobs), Supabase (database), Upstash (queues and caching), Resend (email) and Stripe (payments);
        </li>
        <li>with members of your workspace, as the workspace features require;</li>
        <li>when the law requires it, or to protect the rights, safety and security of users, the public or us;</li>
        <li>as part of a merger, acquisition or sale of assets, in which case this policy continues to apply.</li>
      </ul>

      <h2>6. How long we keep it</h2>
      <p>
        We keep account and workspace information while your workspace is active. When a workspace is closed we disable
        it, revoke its API keys and webhooks, and delete or anonymise personal information we no longer need, except
        security and audit records and billing records that we must keep for legal, tax or dispute purposes. Public
        market data and the history of creators’ public calls are kept so that accuracy scores stay honest.
      </p>

      <h2>7. Your choices and rights</h2>
      <p>
        You can update your details in Settings, and workspace owners can download a workspace export from Settings. You
        can also ask us to access, correct, delete or restrict your personal information, or object to how we use it.
        Depending on where you live, including the EU, UK and California, you may have additional rights, and you can
        complain to your local data protection authority. Send requests to <ContactLine />; we will respond within 30
        days and may need to verify your identity. We do not treat you differently for exercising your rights.
      </p>

      <h2>8. Security</h2>
      <p>
        We protect information with encryption in transit, hashed passwords and API keys, per-workspace access controls
        in the database and audit logging. No system is perfectly secure, so please use a strong, unique password.
      </p>

      <h2>9. International transfers</h2>
      <p>
        Our providers may process information in the United States and other countries. Where required, we rely on
        appropriate safeguards such as standard contractual clauses.
      </p>

      <h2>10. Children</h2>
      <p>
        Sentiment is not intended for anyone under 18, and we do not knowingly collect personal information from
        children. If you think a child has given us information, contact us and we will delete it.
      </p>

      <h2>11. Changes to this policy</h2>
      <p>
        We will post any changes here and update the effective date. If a change is material we will notify you by email
        or in the app before it takes effect.
      </p>

      <h2>12. Contact</h2>
      <p>
        Privacy questions and requests: <ContactLine />.
      </p>
    </LegalDocument>
  );
}
