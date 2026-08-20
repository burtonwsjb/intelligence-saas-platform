import { createEmailProvider, type EmailProvider } from "./mail/index.js";
import { renderEmailTemplate } from "./mail/templates.js";

export type VerificationMessage = {
  to: string;
  url: string;
};

export type EmailDelivery = {
  send: (message: VerificationMessage) => Promise<void>;
};

export function createMemoryInbox(): {
  messages: VerificationMessage[];
  delivery: EmailDelivery;
} {
  const messages: VerificationMessage[] = [];
  return {
    messages,
    delivery: {
      async send(message) {
        messages.push(message);
      },
    },
  };
}

export function createEmailDelivery(options: {
  nodeEnv: string;
  mode?: string;
  resendApiKey?: string;
  provider?: EmailProvider;
}): EmailDelivery {
  const mode =
    options.mode ?? (options.nodeEnv === "production" ? "resend" : "file");

  if (mode === "memory") {
    throw new Error("Use createMemoryInbox() for AUTH_EMAIL_MODE=memory.");
  }

  const provider =
    options.provider ??
    createEmailProvider({
      nodeEnv: options.nodeEnv,
      mode,
      resendApiKey: options.resendApiKey,
    });

  return {
    async send(message) {
      if (options.nodeEnv === "production") {
        const health = await provider.healthCheck();
        if (!health.ok) {
          throw new Error(
            "Email delivery is not configured for production. Configure Resend in the email phase.",
          );
        }
      }
      const rendered = renderEmailTemplate("verify_email", { verifyUrl: message.url });
      await provider.sendTemplate({
        to: message.to,
        templateKey: rendered.templateKey,
        templateVersion: rendered.templateVersion,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      if (provider.name === "local") {
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(".local", { recursive: true });
        await writeFile(".local/verification-url.txt", `${message.to}\n${message.url}\n`, "utf8");
      }
    },
  };
}
