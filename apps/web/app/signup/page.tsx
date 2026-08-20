import Link from "next/link";
import { AuthForm } from "@/components/AuthForm";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string }>;
}) {
  const query = await searchParams;
  const inviteOnly = process.env.BETA_INVITE_ONLY === "true";
  return (
    <>
      <h1>Sign up</h1>
      {inviteOnly ? (
        <p className="muted">This environment is invite-only. Use the token from your operator.</p>
      ) : null}
      <AuthForm mode="signup" inviteOnly={inviteOnly} inviteToken={query.invite} />
      <p className="muted">
        Already have an account? <Link href="/login">Log in</Link>
      </p>
    </>
  );
}
