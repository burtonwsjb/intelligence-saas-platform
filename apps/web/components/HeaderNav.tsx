import { getOptionalSession } from "@/lib/session";
import { getDb } from "@/lib/auth";
import { signOutAction } from "@/app/actions";
import { checkPlatformAdminAccess } from "@isp/db";
import Link from "next/link";

export async function HeaderNav() {
  const session = await getOptionalSession();

  if (!session) {
    return (
      <nav className="shell-nav" aria-label="Primary">
        <Link href="/login">Log in</Link>
        <Link className="button small" href="/signup">
          Start free
        </Link>
      </nav>
    );
  }

  // The operator console is not a customer destination, so only operators see the link.
  const operator = await checkPlatformAdminAccess(getDb(), {
    userId: session.user.id,
    email: session.user.email,
  }).catch(() => ({ granted: false }));

  return (
    <nav className="shell-nav" aria-label="Primary">
      <Link href="/app">Dashboard</Link>
      {operator.granted ? <Link href="/admin">Admin</Link> : null}
      <form action={signOutAction}>
        <button className="link-button" type="submit">
          Sign out
        </button>
      </form>
    </nav>
  );
}
