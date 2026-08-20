import { mkdir, writeFile } from "node:fs/promises";
import type { EmailHealth, EmailProvider, TemplateEmail, TransactionalEmail } from "./provider.js";

export class LocalEmailProvider implements EmailProvider {
  readonly name = "local";

  constructor(private readonly directory = ".local/mail") {}

  async healthCheck(): Promise<EmailHealth> {
    return { ok: true, provider: this.name, detail: "local_filesystem" };
  }

  async sendTransactional(message: TransactionalEmail) {
    return this.write("transactional", message.to, message.subject, message.text);
  }

  async sendTemplate(message: TemplateEmail) {
    return this.write(message.templateKey, message.to, message.subject, message.text);
  }

  private async write(kind: string, to: string, subject: string, text: string) {
    await mkdir(this.directory, { recursive: true });
    const id = crypto.randomUUID();
    await writeFile(
      `${this.directory}/${id}.txt`,
      [`id=${id}`, `kind=${kind}`, `to=${to}`, `subject=${subject}`, text].join("\n"),
      "utf8",
    );
    return { providerMessageId: id };
  }
}

export class LogEmailProvider implements EmailProvider {
  readonly name = "log";

  async healthCheck(): Promise<EmailHealth> {
    return { ok: true, provider: this.name, detail: "stdout" };
  }

  async sendTransactional(message: TransactionalEmail) {
    console.info("email.transactional", { to: message.to, subject: message.subject });
    return { providerMessageId: `log_${crypto.randomUUID()}` };
  }

  async sendTemplate(message: TemplateEmail) {
    console.info("email.template", {
      to: message.to,
      templateKey: message.templateKey,
      subject: message.subject,
    });
    return { providerMessageId: `log_${crypto.randomUUID()}` };
  }
}
