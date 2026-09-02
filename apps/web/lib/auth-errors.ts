export function publicAuthErrorMessage(mode: "login" | "signup"): string {
  if (mode === "login") {
    return "Unable to sign in.";
  }
  return "Unable to create the account. If you already have one, try signing in.";
}

export function publicAuthRouteError(): string {
  return "Unable to complete that request.";
}
