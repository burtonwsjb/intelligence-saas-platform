import type { EmailHealth, EmailProvider, TemplateEmail, TransactionalEmail } from "./provider.js";

export type FixtureEmailMessage = TemplateEmail | (TransactionalEmail & { templateKey?: string });

export class FixtureEmailProvider implements EmailProvider {
  readonly name = "fixture";
  readonly messages: FixtureEmailMessage[] = [];

  async healthCheck(): Promise<EmailHealth> {
    return { ok: true, provider: this.name, detail: "memory" };
  }

  async sendTransactional(message: TransactionalEmail) {
    this.messages.push(message);
    return { providerMessageId: `fixture_${this.messages.length}` };
  }

  async sendTemplate(message: TemplateEmail) {
    this.messages.push(message);
    return { providerMessageId: `fixture_${this.messages.length}` };
  }
}
