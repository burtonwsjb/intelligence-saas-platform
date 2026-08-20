import { escapeHtml, escapeText } from "./escape.js";

export const EMAIL_TEMPLATE_KEYS = [
  "verify_email",
  "welcome",
  "onboarding_reminder",
  "api_key_created",
  "usage_warning",
  "billing_payment_issue",
  "subscription_changed",
  "webhook_failure",
  "security_notification",
  "opportunity_alert",
  "creator_call_alert",
  "prediction_outcome",
  "weekly_intelligence_digest",
] as const;

export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];

export const MARKETING_TEMPLATE_KEYS = ["weekly_intelligence_digest"] as const;

export type RenderedEmail = {
  templateKey: EmailTemplateKey;
  templateVersion: string;
  subject: string;
  html: string;
  text: string;
  requiresMarketingConsent: boolean;
  category: "account" | "billing" | "security" | "product" | "usage" | "marketing" | "opportunity" | "prediction" | "creator_alert";
};

const TEMPLATE_VERSION = "mail.v1";

function layout(input: { title: string; htmlBody: string; textBody: string; unsubscribe?: boolean }): {
  html: string;
  text: string;
} {
  const unsubHtml = input.unsubscribe
    ? `<p><a href="https://app.local/settings/notifications">Unsubscribe from marketing</a></p>`
    : "";
  const unsubText = input.unsubscribe ? "\nUnsubscribe: https://app.local/settings/notifications\n" : "";
  return {
    html: `<!doctype html><html><body><h1>${escapeHtml(input.title)}</h1>${input.htmlBody}${unsubHtml}</body></html>`,
    text: `${input.title}\n\n${input.textBody}${unsubText}`,
  };
}

export function renderEmailTemplate(
  templateKey: EmailTemplateKey,
  variables: Record<string, string>,
): RenderedEmail {
  const pick = (key: string) => escapeText(variables[key] ?? "");
  const htmlPick = (key: string) => escapeHtml(pick(key));

  const renderers: Record<EmailTemplateKey, () => Omit<RenderedEmail, "templateKey" | "templateVersion">> = {
    verify_email: () => {
      const built = layout({
        title: "Verify your email",
        htmlBody: `<p>Confirm your address to finish signup.</p><p><a href="${htmlPick("verifyUrl")}">Verify email</a></p>`,
        textBody: `Confirm your address:\n${pick("verifyUrl")}`,
      });
      return {
        subject: "Verify your email",
        category: "security",
        requiresMarketingConsent: false,
        ...built,
      };
    },
    welcome: () => {
      const built = layout({
        title: "Welcome",
        htmlBody: `<p>Welcome to the intelligence platform, ${htmlPick("displayName")}.</p>`,
        textBody: `Welcome to the intelligence platform, ${pick("displayName")}.`,
      });
      return { subject: "Welcome", category: "account", requiresMarketingConsent: false, ...built };
    },
    onboarding_reminder: () => {
      const built = layout({
        title: "Finish onboarding",
        htmlBody: `<p>${htmlPick("displayName")}, create an API key or ingest your first event to activate.</p>`,
        textBody: `${pick("displayName")}, create an API key or ingest your first event to activate.`,
      });
      return {
        subject: "Finish onboarding",
        category: "product",
        requiresMarketingConsent: false,
        ...built,
      };
    },
    api_key_created: () => {
      const built = layout({
        title: "API key created",
        htmlBody: `<p>A key named ${htmlPick("keyName")} was created. The secret is shown only once in the console.</p>`,
        textBody: `A key named ${pick("keyName")} was created. The secret is shown only once in the console.`,
      });
      return {
        subject: "API key created",
        category: "security",
        requiresMarketingConsent: false,
        ...built,
      };
    },
    usage_warning: () => {
      const built = layout({
        title: "Usage warning",
        htmlBody: `<p>${htmlPick("meterKey")} reached ${htmlPick("thresholdPct")}% of this period's limit.</p>`,
        textBody: `${pick("meterKey")} reached ${pick("thresholdPct")}% of this period's limit.`,
      });
      return { subject: "Usage warning", category: "usage", requiresMarketingConsent: false, ...built };
    },
    billing_payment_issue: () => {
      const built = layout({
        title: "Payment issue",
        htmlBody: `<p>We could not process the latest payment for ${htmlPick("planKey")}.</p>`,
        textBody: `We could not process the latest payment for ${pick("planKey")}.`,
      });
      return {
        subject: "Payment issue",
        category: "billing",
        requiresMarketingConsent: false,
        ...built,
      };
    },
    subscription_changed: () => {
      const built = layout({
        title: "Subscription updated",
        htmlBody: `<p>Your plan is now ${htmlPick("planKey")} (${htmlPick("status")}).</p>`,
        textBody: `Your plan is now ${pick("planKey")} (${pick("status")}).`,
      });
      return {
        subject: "Subscription updated",
        category: "billing",
        requiresMarketingConsent: false,
        ...built,
      };
    },
    webhook_failure: () => {
      const built = layout({
        title: "Webhook delivery failed",
        htmlBody: `<p>Deliveries to ${htmlPick("endpointHost")} are failing. The signing secret is never emailed.</p>`,
        textBody: `Deliveries to ${pick("endpointHost")} are failing. The signing secret is never emailed.`,
      });
      return {
        subject: "Webhook delivery failed",
        category: "account",
        requiresMarketingConsent: false,
        ...built,
      };
    },
    security_notification: () => {
      const built = layout({
        title: "Security notification",
        htmlBody: `<p>${htmlPick("summary")}</p>`,
        textBody: pick("summary"),
      });
      return {
        subject: "Security notification",
        category: "security",
        requiresMarketingConsent: false,
        ...built,
      };
    },
    opportunity_alert: () => {
      const built = layout({
        title: "Opportunity alert",
        htmlBody: `<p>${htmlPick("printingLabel")} scored ${htmlPick("opportunityScore")} (${htmlPick("recommendation")}).</p>`,
        textBody: `${pick("printingLabel")} scored ${pick("opportunityScore")} (${pick("recommendation")}).`,
      });
      return {
        subject: "Opportunity alert",
        category: "opportunity",
        requiresMarketingConsent: false,
        ...built,
      };
    },
    creator_call_alert: () => {
      const built = layout({
        title: "Creator call",
        htmlBody: `<p>${htmlPick("creatorName")} published a ${htmlPick("direction")} call.</p>`,
        textBody: `${pick("creatorName")} published a ${pick("direction")} call.`,
      });
      return {
        subject: "Creator call",
        category: "creator_alert",
        requiresMarketingConsent: false,
        ...built,
      };
    },
    prediction_outcome: () => {
      const built = layout({
        title: "Prediction outcome",
        htmlBody: `<p>Horizon ${htmlPick("horizon")} resolved as ${htmlPick("outcome")}.</p>`,
        textBody: `Horizon ${pick("horizon")} resolved as ${pick("outcome")}.`,
      });
      return {
        subject: "Prediction outcome",
        category: "prediction",
        requiresMarketingConsent: false,
        ...built,
      };
    },
    weekly_intelligence_digest: () => {
      const built = layout({
        title: "Weekly digest",
        htmlBody: `<p>${htmlPick("summary")}</p>`,
        textBody: pick("summary"),
        unsubscribe: true,
      });
      return {
        subject: "Weekly intelligence digest",
        category: "marketing",
        requiresMarketingConsent: true,
        ...built,
      };
    },
  };

  return {
    templateKey,
    templateVersion: TEMPLATE_VERSION,
    ...renderers[templateKey](),
  };
}

export function isEmailTemplateKey(value: string): value is EmailTemplateKey {
  return (EMAIL_TEMPLATE_KEYS as readonly string[]).includes(value);
}
