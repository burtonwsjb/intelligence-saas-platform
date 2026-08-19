import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

export function deriveWebhookKey(pepper: string): Buffer {
  return createHmac("sha256", "isp.webhook.v1").update(pepper).digest();
}

export function encryptWebhookSecret(plaintext: string, pepper: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveWebhookKey(pepper), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64url");
}

export function decryptWebhookSecret(ciphertext: string, pepper: string): string {
  const buf = Buffer.from(ciphertext, "base64url");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", deriveWebhookKey(pepper), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function hashWebhookSecret(plaintext: string, pepper: string): string {
  return createHmac("sha256", pepper).update(plaintext).digest("hex");
}

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

export function signWebhookPayload(input: { secret: string; timestamp: string; body: string }): string {
  const mac = createHmac("sha256", input.secret).update(`${input.timestamp}.${input.body}`).digest("hex");
  return `v1=${mac}`;
}

export function webhookSignatureValid(input: {
  secret: string;
  timestamp: string;
  body: string;
  signature: string;
  now?: Date;
}): boolean {
  const issued = Number(input.timestamp);
  if (!Number.isFinite(issued)) {
    return false;
  }
  const now = (input.now ?? new Date()).getTime();
  if (Math.abs(now - issued) > 5 * 60 * 1000) {
    return false;
  }
  const expected = signWebhookPayload({
    secret: input.secret,
    timestamp: input.timestamp,
    body: input.body,
  });
  if (expected.length !== input.signature.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= expected.charCodeAt(i) ^ input.signature.charCodeAt(i);
  }
  return mismatch === 0;
}
