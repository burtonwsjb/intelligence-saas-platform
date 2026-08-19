import { requirePageOrganization } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AppPage() {
  const { session, organizationId } = await requirePageOrganization();

  return (
    <>
      <h1>Customer application</h1>
      <p>Signed in as {session.user.email}.</p>
      <p>Active tenant (server-resolved): {organizationId}</p>
      <p>
        <a href="/app/keys">API keys</a> · <a href="/app/billing">Billing</a>
      </p>
      <p className="muted">
        Dashboard features land in later phases. This page proves the
        authenticated tenant session plus Phase 04 key and billing foundations.
      </p>
    </>
  );
}
