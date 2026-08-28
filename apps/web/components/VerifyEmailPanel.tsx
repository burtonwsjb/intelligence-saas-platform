"use client";

import { useCallback, useEffect, useState } from "react";
import {
  VERIFICATION_SENT_MESSAGE,
  VERIFICATION_UNAVAILABLE_MESSAGE,
  formatResendCountdown,
  persistVerificationResendState,
  readVerificationResendState,
  remainingCooldownSeconds,
} from "@/lib/verification-cooldown";

export function VerifyEmailPanel() {
  const [email, setEmail] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<"idle" | "sent" | "unavailable">("idle");

  useEffect(() => {
    const stored = readVerificationResendState();
    setEmail(stored.email);
    setCooldownUntil(stored.cooldownUntil);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);

  const remaining = remainingCooldownSeconds(cooldownUntil, now);
  const canResend = Boolean(email) && remaining === 0 && !pending;

  const onResend = useCallback(async () => {
    if (!email || remaining > 0 || pending) {
      return;
    }
    setPending(true);
    setStatus("idle");
    try {
      const response = await fetch("/api/verification/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email }),
      });
      const body: unknown = await response.json().catch(() => null);
      const ok =
        response.ok &&
        Boolean(body && typeof body === "object" && "ok" in body && (body as { ok: unknown }).ok);
      if (ok) {
        const next = persistVerificationResendState(email, Date.now());
        setCooldownUntil(next.cooldownUntil);
        setNow(Date.now());
        setStatus("sent");
      } else {
        setStatus("unavailable");
      }
    } catch {
      setStatus("unavailable");
    } finally {
      setPending(false);
    }
  }, [email, pending, remaining]);

  let liveMessage = "\u00a0";
  if (pending) {
    liveMessage = "Sending verification email.";
  } else if (status === "sent") {
    liveMessage = VERIFICATION_SENT_MESSAGE;
  } else if (status === "unavailable") {
    liveMessage = VERIFICATION_UNAVAILABLE_MESSAGE;
  }

  const countdown = remaining > 0 ? formatResendCountdown(remaining) : "\u00a0";

  return (
    <>
      <h1>Verify your email</h1>
      <p>
        We sent a verification link to your email address. Click the link to finish setting up
        your account.
      </p>
      <p className="muted">
        {"Didn't receive it? Check your spam folder or resend the verification email."}
      </p>
      <div className="verify-email-actions">
        <button
          type="button"
          disabled={!canResend}
          aria-busy={pending}
          aria-disabled={!canResend}
          onClick={() => {
            void onResend();
          }}
        >
          Resend verification email
        </button>
        <p className="muted verify-email-slot" aria-live="polite">
          {countdown}
        </p>
        <p className="verify-email-slot" role="status" aria-live="polite">
          {liveMessage}
        </p>
        <p>
          <a href="/login">Back to sign in</a>
        </p>
      </div>
    </>
  );
}
