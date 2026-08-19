import { getOptionalSession } from "@/lib/session";
import { signOutAction } from "@/app/actions";
import Link from "next/link";

export async function HeaderNav() {
  const session = await getOptionalSession();

  if (!session) {
    return (
      <nav className="shell-nav" aria-label="Primary">
        <Link href="/login">Log in</Link>
        <Link href="/signup">Sign up</Link>
      </nav>
    );
  }

  return (
    <nav className="shell-nav" aria-label="Primary">
      <Link href="/app">App</Link>
      <Link href="/app/keys">Keys</Link>
      <Link href="/app/billing">Billing</Link>
      <form action={signOutAction}>
        <button className="link-button" type="submit">
          Sign out
        </button>
      </form>
    </nav>
  );
}
