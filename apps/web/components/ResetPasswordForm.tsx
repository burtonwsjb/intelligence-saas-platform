"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";

/** Sets a new password from a one-time reset token, then sends the user to log in. */
export function ResetPasswordForm({ token }: { token: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("password") ?? "");
    if (newPassword !== String(form.get("confirm") ?? "")) {
      setError("The two passwords do not match.");
      return;
    }
    setPending(true);
    try {
      const result = await authClient.resetPassword({ newPassword, token });
      if (result.error) {
        setError("This reset link is invalid or has expired. Ask your operator for a new one.");
        return;
      }
      window.location.href = "/login";
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={onSubmit}>
      <label>
        New password
        <input name="password" type="password" required minLength={8} autoComplete="new-password" />
      </label>
      <label>
        Confirm new password
        <input name="confirm" type="password" required minLength={8} autoComplete="new-password" />
      </label>
      {error ? <p className="form-error">{error}</p> : null}
      <button type="submit" disabled={pending}>
        {pending ? "Please wait…" : "Set password"}
      </button>
    </form>
  );
}
