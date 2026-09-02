import { cookies } from "next/headers";
import { isHostedRuntime } from "@isp/shared";

export const SECRET_FLASH_COOKIE = "isp_secret_flash";
export const SECRET_FLASH_MAX_AGE_SECONDS = 90;

export const SECRET_FLASH_KINDS = ["api_key", "webhook_secret", "beta_invite"] as const;
export type SecretFlashKind = (typeof SECRET_FLASH_KINDS)[number];

export function encodeSecretFlash(kind: SecretFlashKind, value: string): string {
  return Buffer.from(JSON.stringify({ kind, value }), "utf8").toString("base64url");
}

export function decodeSecretFlash(raw: string | undefined): { kind: SecretFlashKind; value: string } | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      kind?: unknown;
      value?: unknown;
    };
    if (
      typeof parsed.kind !== "string" ||
      !(SECRET_FLASH_KINDS as readonly string[]).includes(parsed.kind) ||
      typeof parsed.value !== "string" ||
      parsed.value.length === 0 ||
      parsed.value.length > 2_000
    ) {
      return null;
    }
    return { kind: parsed.kind as SecretFlashKind, value: parsed.value };
  } catch {
    return null;
  }
}

export async function setSecretFlash(kind: SecretFlashKind, value: string): Promise<void> {
  const jar = await cookies();
  jar.set({
    name: SECRET_FLASH_COOKIE,
    value: encodeSecretFlash(kind, value),
    httpOnly: true,
    sameSite: "lax",
    secure: isHostedRuntime(),
    path: "/",
    maxAge: SECRET_FLASH_MAX_AGE_SECONDS,
  });
}

export async function readSecretFlash(expected: SecretFlashKind): Promise<string | null> {
  const jar = await cookies();
  const decoded = decodeSecretFlash(jar.get(SECRET_FLASH_COOKIE)?.value);
  if (!decoded || decoded.kind !== expected) {
    return null;
  }
  return decoded.value;
}
