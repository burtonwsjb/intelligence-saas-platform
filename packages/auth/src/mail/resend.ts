import {
  EmailNotConfiguredError,
  type EmailHealth,
  type EmailProvider,
  type TemplateEmail,
  type TransactionalEmail,
} from "./provider.js";

/**
 * Production adapter. Requires RESEND_API_KEY. This phase does not send
 * live mail; healthCheck/send fail closed without a configured key.
 */
export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";

  constructor(private readonly apiKey: string | undefined) {}

  async healthCheck(): Promise<EmailHealth> {
    if (!this.apiKey) {
      return { ok: false, provider: this.name, detail: "missing_api_key" };
    }
    return { ok: true, provider: this.name, detail: "configured" };
  }

  async sendTransactional(_message: TransactionalEmail): Promise<{ providerMessageId: string }> {
    if (!this.apiKey) {
      throw new EmailNotConfiguredError();
    }
    throw new EmailNotConfiguredError();
  }

  async sendTemplate(_message: TemplateEmail): Promise<{ providerMessageId: string }> {
    if (!this.apiKey) {
      throw new EmailNotConfiguredError();
    }
    throw new EmailNotConfiguredError();
  }
}
