export type TransactionalEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export type TemplateEmail = {
  to: string;
  templateKey: string;
  templateVersion: string;
  subject: string;
  html: string;
  text: string;
};

export type EmailHealth = {
  ok: boolean;
  provider: string;
  detail: string;
};

export interface EmailProvider {
  readonly name: string;
  sendTransactional(message: TransactionalEmail): Promise<{ providerMessageId: string }>;
  sendTemplate(message: TemplateEmail): Promise<{ providerMessageId: string }>;
  healthCheck(): Promise<EmailHealth>;
}

export class EmailDeliveryFailedError extends Error {
  readonly category: string;
  constructor(message: string, category = "provider_error") {
    super(message);
    this.name = "EmailDeliveryFailedError";
    this.category = category;
  }
}

export class EmailNotConfiguredError extends Error {
  constructor() {
    super("Email delivery is not configured. Production requires a real provider.");
    this.name = "EmailNotConfiguredError";
  }
}
