"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";

type Mode = "login" | "signup";

export function AuthForm({
  mode,
  inviteToken,
  inviteOnly,
}: {
  mode: Mode;
  inviteToken?: string;
  inviteOnly?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    const name = String(form.get("name") ?? "Member");
    const invite = String(form.get("inviteToken") ?? inviteToken ?? "");

    try {
      if (mode === "signup") {
        const result = await authClient.signUp.email({
          email,
          password,
          name,
          callbackURL: "/onboarding",
          fetchOptions: {
            headers: invite
              ? {
                  "x-beta-invite": invite,
                }
              : undefined,
          },
        });
        if (result.error) {
          setError(result.error.message ?? "Unable to sign up.");
          return;
        }
        window.location.href = "/verify-email";
        return;
      }

      const result = await authClient.signIn.email({
        email,
        password,
        callbackURL: "/app",
      });
      if (result.error) {
        setError(result.error.message ?? "Unable to sign in.");
        return;
      }
      window.location.href = "/app";
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={onSubmit}>
      {mode === "signup" && inviteOnly ? (
        <label>
          Invite token
          <input name="inviteToken" type="text" required defaultValue={inviteToken} autoComplete="off" />
        </label>
      ) : null}
      {mode === "signup" ? (
        <label>
          Name
          <input name="name" type="text" required minLength={1} autoComplete="name" />
        </label>
      ) : null}
      <label>
        Email
        <input name="email" type="email" required autoComplete="email" />
      </label>
      <label>
        Password
        <input
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
        />
      </label>
      {error ? <p className="form-error">{error}</p> : null}
      <button type="submit" disabled={pending}>
        {pending ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}
      </button>
    </form>
  );
}
