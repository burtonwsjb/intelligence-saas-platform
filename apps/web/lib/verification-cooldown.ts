export const VERIFICATION_COOLDOWN_MS = 60_000;
export const VERIFY_EMAIL_STORAGE_KEY = "isp.verify.email";
export const VERIFY_COOLDOWN_STORAGE_KEY = "isp.verify.cooldownUntil";

export type VerificationStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type VerificationResendClientState = {
  email: string | null;
  cooldownUntil: number;
};

function fallbackStorage(): VerificationStorage {
  return {
    getItem() {
      return null;
    },
    setItem() {},
  };
}

export function defaultVerificationStorage(): VerificationStorage {
  try {
    if (typeof sessionStorage === "undefined") {
      return fallbackStorage();
    }
    return sessionStorage;
  } catch {
    return fallbackStorage();
  }
}

export function persistVerificationResendState(
  email: string,
  now = Date.now(),
  storage: VerificationStorage = defaultVerificationStorage(),
): VerificationResendClientState {
  const normalized = email.trim().toLowerCase();
  const cooldownUntil = now + VERIFICATION_COOLDOWN_MS;
  try {
    storage.setItem(VERIFY_EMAIL_STORAGE_KEY, normalized);
    storage.setItem(VERIFY_COOLDOWN_STORAGE_KEY, String(cooldownUntil));
  } catch {
    return { email: normalized || null, cooldownUntil };
  }
  return { email: normalized || null, cooldownUntil };
}

export function readVerificationResendState(
  storage: VerificationStorage = defaultVerificationStorage(),
): VerificationResendClientState {
  try {
    const email = storage.getItem(VERIFY_EMAIL_STORAGE_KEY)?.trim().toLowerCase() ?? "";
    const parsed = Number(storage.getItem(VERIFY_COOLDOWN_STORAGE_KEY) ?? 0);
    return {
      email: email || null,
      cooldownUntil: Number.isFinite(parsed) ? parsed : 0,
    };
  } catch {
    return { email: null, cooldownUntil: 0 };
  }
}

export function remainingCooldownSeconds(cooldownUntil: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
}

export function formatResendCountdown(seconds: number): string {
  return `You can resend in ${seconds} seconds`;
}

export const VERIFICATION_SENT_MESSAGE =
  "Verification email sent. Check your inbox and spam folder.";
export const VERIFICATION_UNAVAILABLE_MESSAGE =
  "We couldn't send the email right now. Please try again shortly.";
