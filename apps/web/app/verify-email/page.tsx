export default function VerifyEmailPage() {
  return (
    <>
      <h1>Verify your email</h1>
      <p>
        We sent a verification link. Local development writes or logs that link
        instead of sending production email.
      </p>
      <p className="muted">
        After verifying, return here and <a href="/login">sign in</a>. Production
        email sending is reserved for the later email phase.
      </p>
    </>
  );
}
