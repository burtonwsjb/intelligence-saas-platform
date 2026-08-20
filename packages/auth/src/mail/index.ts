import { FixtureEmailProvider } from "./fixture.js";
import { LocalEmailProvider, LogEmailProvider } from "./local.js";
import { EmailNotConfiguredError, type EmailProvider } from "./provider.js";
import { ResendEmailProvider } from "./resend.js";

export function createEmailProvider(options: {
  nodeEnv: string;
  mode?: string;
  resendApiKey?: string;
}): EmailProvider {
  const mode = options.mode ?? (options.nodeEnv === "production" ? "resend" : "file");

  if (options.nodeEnv === "production") {
    if (mode !== "resend") {
      return new ResendEmailProvider(undefined);
    }
    return new ResendEmailProvider(options.resendApiKey);
  }

  if (mode === "memory" || mode === "fixture") {
    return new FixtureEmailProvider();
  }
  if (mode === "log") {
    return new LogEmailProvider();
  }
  if (mode === "file" || mode === "local") {
    return new LocalEmailProvider();
  }
  if (mode === "resend") {
    return new ResendEmailProvider(options.resendApiKey);
  }
  throw new EmailNotConfiguredError();
}

export {
  EmailDeliveryFailedError,
  EmailNotConfiguredError,
  type EmailHealth,
  type EmailProvider,
  type TemplateEmail,
  type TransactionalEmail,
} from "./provider.js";
export { FixtureEmailProvider } from "./fixture.js";
export { LocalEmailProvider, LogEmailProvider } from "./local.js";
export { ResendEmailProvider } from "./resend.js";
export { renderEmailTemplate, EMAIL_TEMPLATE_KEYS, type EmailTemplateKey } from "./templates.js";
export { escapeHtml } from "./escape.js";
