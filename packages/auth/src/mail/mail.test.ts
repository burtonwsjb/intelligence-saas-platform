import { describe, expect, it } from "vitest";
import {
  createEmailProvider,
  escapeHtml,
  renderEmailTemplate,
  EmailDeliveryFailedError,
  FixtureEmailProvider,
  ResendEmailProvider,
  sanitizeResendError,
} from "./index.js";
import { createEmailDelivery } from "../email.js";

describe("email templates and providers", () => {
  it("escapes user-controlled HTML and never interpolates secrets", () => {
    const rendered = renderEmailTemplate("welcome", {
      displayName: `<script>alert("x")</script>`,
    });
    expect(rendered.html).toContain("&lt;script&gt;");
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.text).toContain(`<script>alert("x")</script>`);
    expect(rendered.html).not.toMatch(/isp_test_|sk_live_|whsec_/);
    const digest = renderEmailTemplate("weekly_intelligence_digest", { summary: "Hello" });
    expect(digest.requiresMarketingConsent).toBe(true);
    expect(digest.text).toMatch(/Unsubscribe/);
    expect(digest.text).toContain("/app/settings");
    expect(digest.html).toContain("/app/settings");
    expect(digest.html).not.toContain("/settings/notifications");
  });

  it("uses a local/fixture provider without RESEND_API_KEY and fails closed in production", async () => {
    const fixture = new FixtureEmailProvider();
    const rendered = renderEmailTemplate("api_key_created", { keyName: "prod" });
    await fixture.sendTemplate({
      to: "user@example.com",
      templateKey: rendered.templateKey,
      templateVersion: rendered.templateVersion,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    expect(fixture.messages).toHaveLength(1);
    expect(JSON.stringify(fixture.messages[0])).not.toMatch(/isp_test_/);

    const local = createEmailProvider({ nodeEnv: "test", mode: "fixture" });
    expect(local.name).toBe("fixture");
    await expect(local.healthCheck()).resolves.toMatchObject({ ok: true });

    const resend = new ResendEmailProvider(undefined);
    await expect(resend.healthCheck()).resolves.toMatchObject({ ok: false });
    await expect(
      resend.sendTemplate({
        to: "a@example.com",
        templateKey: "welcome",
        templateVersion: "mail.v1",
        subject: "x",
        html: "x",
        text: "x",
      }),
    ).rejects.toThrow(/not configured/);

    const delivery = createEmailDelivery({ nodeEnv: "production" });
    await expect(delivery.send({ to: "a@example.com", url: "https://example.invalid" })).rejects.toThrow(/Resend/);
    expect(escapeHtml("<b>")).toBe("&lt;b&gt;");
  });
});

const RESEND_KEY = "re_test_abcdefghijklmnopqrstuvwxyz123456";
const RESEND_FROM = "Intelligence SaaS <verify@example.invalid>";
const VERIFY_URL = "https://isp-staging-web.vercel.app/verify-email?token=verify_token_example";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Resend HTTP delivery", () => {
  it("fails closed without an API key", async () => {
    const provider = new ResendEmailProvider(undefined, RESEND_FROM);
    await expect(provider.healthCheck()).resolves.toMatchObject({ ok: false, detail: "missing_api_key" });
    await expect(
      provider.sendTransactional({
        to: "user@example.com",
        subject: "x",
        html: "x",
        text: "x",
      }),
    ).rejects.toThrow(/not configured/);
  });

  it("fails closed without a sender", async () => {
    const provider = new ResendEmailProvider(RESEND_KEY, undefined);
    await expect(provider.healthCheck()).resolves.toMatchObject({
      ok: false,
      detail: "missing_from_email",
    });
    await expect(
      provider.sendTemplate({
        to: "user@example.com",
        templateKey: "verify_email",
        templateVersion: "mail.v1",
        subject: "Verify your email",
        html: "x",
        text: "x",
      }),
    ).rejects.toThrow(/not configured/);
  });

  it("sends a mocked Resend delivery and returns the provider message id", async () => {
    const fetchMock: typeof fetch = async () => jsonResponse(200, { id: "msg_test_1" });
    const provider = new ResendEmailProvider(RESEND_KEY, RESEND_FROM, { fetch: fetchMock });
    const result = await provider.sendTransactional({
      to: "user@example.com",
      subject: "Hello",
      html: "<p>Hello</p>",
      text: "Hello",
    });
    expect(result.providerMessageId).toBe("msg_test_1");
  });

  it("treats provider 4xx and 5xx as delivery failures without leaking the API key", async () => {
    const failing: typeof fetch = async () =>
      jsonResponse(401, { message: `Invalid API key: ${RESEND_KEY}` });
    const provider = new ResendEmailProvider(RESEND_KEY, RESEND_FROM, { fetch: failing });
    try {
      await provider.sendTransactional({
        to: "user@example.com",
        subject: "x",
        html: "x",
        text: "x",
      });
      throw new Error("expected delivery failure");
    } catch (error) {
      expect(error).toBeInstanceOf(EmailDeliveryFailedError);
      const message = error instanceof Error ? error.message : "";
      expect(message).toMatch(/Resend delivery failed \(401\)/);
      expect(message).not.toContain(RESEND_KEY);
      expect(JSON.stringify(error)).not.toContain(RESEND_KEY);
    }

    const unavailable: typeof fetch = async () => jsonResponse(503, { message: "unavailable" });
    const down = new ResendEmailProvider(RESEND_KEY, RESEND_FROM, { fetch: unavailable });
    await expect(
      down.sendTransactional({ to: "user@example.com", subject: "x", html: "x", text: "x" }),
    ).rejects.toMatchObject({ name: "EmailDeliveryFailedError", category: "provider_unavailable" });
  });

  it("does not leak secrets from sanitized provider errors", () => {
    expect(sanitizeResendError(`Bearer ${RESEND_KEY} ${VERIFY_URL}`)).not.toContain(RESEND_KEY);
    expect(sanitizeResendError(`Bearer ${RESEND_KEY} ${VERIFY_URL}`)).not.toContain(VERIFY_URL);
    expect(sanitizeResendError(`key ${RESEND_KEY}`)).toBe("key [redacted]");
    expect(sanitizeResendError(`key ${RESEND_KEY}`)).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("sends the verify_email template to the recipient with the verification URL", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchMock: typeof fetch = async (input, init) => {
      captured = { url: String(input), init: init ?? {} };
      return jsonResponse(200, { id: "msg_verify_1" });
    };
    const delivery = createEmailDelivery({
      nodeEnv: "production",
      mode: "resend",
      resendApiKey: RESEND_KEY,
      resendFromEmail: RESEND_FROM,
      resendFetch: fetchMock,
    });
    await delivery.send({ to: "member@example.com", url: VERIFY_URL });
    expect(captured?.url).toBe("https://api.resend.com/emails");
    const payload = JSON.parse(String(captured?.init.body)) as {
      from: string;
      to: string[];
      subject: string;
      html: string;
      text: string;
    };
    expect(payload.from).toBe(RESEND_FROM);
    expect(payload.to).toEqual(["member@example.com"]);
    expect(payload.subject).toBe("Verify your email");
    expect(payload.text).toContain(VERIFY_URL);
    expect(payload.html).toContain("Verify email");
    expect(JSON.stringify(captured?.init.headers)).not.toContain(VERIFY_URL);
  });

  it("uses Resend on hosted staging instead of local or file mode", () => {
    const provider = createEmailProvider({
      nodeEnv: "production",
      mode: "resend",
      resendApiKey: RESEND_KEY,
      resendFromEmail: RESEND_FROM,
    });
    expect(provider.name).toBe("resend");
    expect(provider.name).not.toBe("local");
    const stagingFile = createEmailProvider({
      nodeEnv: "production",
      mode: "file",
    });
    expect(stagingFile.name).toBe("resend");
    const localDev = createEmailProvider({ nodeEnv: "development", mode: "file" });
    expect(localDev.name).toBe("local");
  });
});
