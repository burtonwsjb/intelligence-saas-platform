import Link from "next/link";
import { AuthForm } from "@/components/AuthForm";
import { safeInternalPath } from "@/lib/security-headers";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const query = await searchParams;
  const nextPath = safeInternalPath(query.next) ?? "/app";
  return (
    <>
      <h1>Log in</h1>
      <AuthForm mode="login" nextPath={nextPath} />
      <p className="muted">
        Need an account? <Link href="/signup">Sign up</Link>
      </p>
    </>
  );
}
