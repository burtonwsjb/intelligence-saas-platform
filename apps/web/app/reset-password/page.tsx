import Link from "next/link";
import { ResetPasswordForm } from "@/components/ResetPasswordForm";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const query = await searchParams;
  const token = query.token?.trim();
  return (
    <>
      <h1>Set a new password</h1>
      {token && !query.error ? (
        <ResetPasswordForm token={token} />
      ) : (
        <p className="muted">This reset link is invalid or has expired. Ask your operator for a new one.</p>
      )}
      <p className="muted">
        <Link href="/login">Back to log in</Link>
      </p>
    </>
  );
}
