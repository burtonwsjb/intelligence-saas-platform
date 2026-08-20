import { describe, expect, it } from "vitest";
import {
  createEmailProvider,
  escapeHtml,
  renderEmailTemplate,
  FixtureEmailProvider,
  ResendEmailProvider,
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
