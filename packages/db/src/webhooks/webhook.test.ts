import { describe, expect, it } from "vitest";
import {
  WebhookUrlRejectedError,
  assertPublicWebhookUrl,
  assertResolvedAddressesPublic,
} from "./ssrf.js";
import { signWebhookPayload, webhookSignatureValid } from "./secret.js";

describe("webhook SSRF defense", () => {
  it("rejects localhost, loopback, private IPv4, IPv6 loopback, and non-http schemes", () => {
    expect(() => assertPublicWebhookUrl("http://localhost/hook")).toThrow(WebhookUrlRejectedError);
    expect(() => assertPublicWebhookUrl("http://127.0.0.1/hook")).toThrow(WebhookUrlRejectedError);
    expect(() => assertPublicWebhookUrl("http://10.0.0.8/hook")).toThrow(WebhookUrlRejectedError);
    expect(() => assertPublicWebhookUrl("http://192.168.1.9/hook")).toThrow(WebhookUrlRejectedError);
    expect(() => assertPublicWebhookUrl("http://172.16.0.4/hook")).toThrow(WebhookUrlRejectedError);
    expect(() => assertPublicWebhookUrl("http://[::1]/hook")).toThrow(WebhookUrlRejectedError);
    expect(() => assertPublicWebhookUrl("ftp://example.com/hook")).toThrow(WebhookUrlRejectedError);
    expect(() => assertPublicWebhookUrl("http://169.254.169.254/latest")).toThrow(WebhookUrlRejectedError);
    expect(() => assertResolvedAddressesPublic(["127.0.0.1"])).toThrow(WebhookUrlRejectedError);
    expect(() => assertResolvedAddressesPublic(["::1"])).toThrow(WebhookUrlRejectedError);
    expect(() => assertPublicWebhookUrl("https://example.com/hooks/isp")).not.toThrow();
  });
});

describe("webhook signatures", () => {
  it("accepts a timely HMAC and rejects replayed timestamps", () => {
    const secret = "whsec_test";
    const timestamp = String(Date.parse("2026-01-04T00:00:00.000Z"));
    const body = '{"id":"evt_1"}';
    const signature = signWebhookPayload({ secret, timestamp, body });
    expect(
      webhookSignatureValid({
        secret,
        timestamp,
        body,
        signature,
        now: new Date("2026-01-04T00:01:00.000Z"),
      }),
    ).toBe(true);
    expect(
      webhookSignatureValid({
        secret,
        timestamp,
        body,
        signature,
        now: new Date("2026-01-04T00:10:00.000Z"),
      }),
    ).toBe(false);
  });
});
