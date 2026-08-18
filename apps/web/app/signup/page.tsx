import Link from "next/link";
import { AuthForm } from "@/components/AuthForm";

export default function SignupPage() {
  return (
    <>
      <h1>Sign up</h1>
      <AuthForm mode="signup" />
      <p className="muted">
        Already have an account? <Link href="/login">Log in</Link>
      </p>
    </>
  );
}
