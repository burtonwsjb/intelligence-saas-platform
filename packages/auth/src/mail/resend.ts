import { structuredLog } from "@isp/shared";
import {
  EmailDeliveryFailedError,
  EmailNotConfiguredError,
  type EmailHealth,
  type EmailProvider,
  type TemplateEmail,
  type TransactionalEmail,
} from "./provider.js";

const RESEND_EMAILS_URL = "https://api.resend.com/emails";
const DEFAULT_TIMEOUT_MS = 10_000;

export type ResendRuntime = {
  fetch?: typeof fetch;
  timeoutMs?: number;
};

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function sanitizeResendError(value: string): string {
  return value
    .replace(/\bre_[A-Za-z0-9_]+/gi, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/https?:\/\/[^\s"'\\]+/gi, "[redacted]")
    .replace(/postgresql:\/\/[^\s"'\\]+/gi, "[redacted]")
    .slice(0, 300);
}

function parseProviderMessageId(bodyText: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed && typeof parsed === "object" && "id" in parsed) {
      const id = (parsed as { id: unknown }).id;
      if (typeof id === "string" && id.trim()) {
        return id.trim();
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("name" in error)) {
    return false;
  }
  const name = String((error as { name: unknown }).name);
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * Production Resend adapter. Sends via the Resend HTTP API.
 * Fails closed without RESEND_API_KEY and RESEND_FROM_EMAIL.
 */
export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";
  private readonly apiKey: string | undefined;
  private readonly fromEmail: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(apiKey?: string, fromEmail?: string, runtime: ResendRuntime = {}) {
    this.apiKey = present(apiKey);
    this.fromEmail = present(fromEmail);
    this.fetchImpl = runtime.fetch ?? fetch;
    this.timeoutMs = runtime.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async healthCheck(): Promise<EmailHealth> {
    if (!this.apiKey) {
      return { ok: false, provider: this.name, detail: "missing_api_key" };
    }
    if (!this.fromEmail) {
      return { ok: false, provider: this.name, detail: "missing_from_email" };
    }
    return { ok: true, provider: this.name, detail: "configured" };
  }

  async sendTransactional(message: TransactionalEmail): Promise<{ providerMessageId: string }> {
    return this.deliver(message);
  }

  async sendTemplate(message: TemplateEmail): Promise<{ providerMessageId: string }> {
    return this.deliver({
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  }

  private async deliver(message: TransactionalEmail): Promise<{ providerMessageId: string }> {
    if (!this.apiKey || !this.fromEmail) {
      throw new EmailNotConfiguredError();
    }

    let response: Response;
    try {
      response = await this.fetchImpl(RESEND_EMAILS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.fromEmail,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new EmailDeliveryFailedError("Resend request timed out", "timeout");
      }
      const raw = error instanceof Error ? error.message : "network error";
      throw new EmailDeliveryFailedError(sanitizeResendError(raw), "network");
    }

    const bodyText = await response.text().catch(() => "");
    if (response.status < 200 || response.status >= 300) {
      const detail = sanitizeResendError(bodyText || `http_${response.status}`);
      structuredLog("error", "email.resend_failed", {
        status: response.status,
        detail,
      });
      throw new EmailDeliveryFailedError(
        `Resend delivery failed (${response.status})`,
        response.status >= 500 ? "provider_unavailable" : "provider_rejected",
      );
    }

    const providerMessageId = parseProviderMessageId(bodyText);
    if (!providerMessageId) {
      throw new EmailDeliveryFailedError("Resend response missing message id", "provider_error");
    }
    return { providerMessageId };
  }
}
