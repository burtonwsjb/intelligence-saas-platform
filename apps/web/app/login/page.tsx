import Link from "next/link";
import { AuthForm } from "@/components/AuthForm";

export default function LoginPage() {
  return (
    <>
      <h1>Log in</h1>
      <AuthForm mode="login" />
      <p className="muted">
        Need an account? <Link href="/signup">Sign up</Link>
      </p>
    </>
  );
}
