import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createInitialOrganization } from "@/app/actions";
import { getAuth } from "@/lib/auth";
import { requirePageSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requirePageSession();
  const requestHeaders = await headers();
  const existing = await getAuth().api.listOrganizations({
    headers: requestHeaders,
  });
  if (Array.isArray(existing) && existing.length > 0) {
    await getAuth().api.setActiveOrganization({
      headers: requestHeaders,
      body: { organizationId: existing[0]!.id },
    });
    redirect("/app");
  }

  const params = await searchParams;

  return (
    <>
      <h1>Create your workspace</h1>
      <p className="muted">Name the space where you track topics, cards and creators. You can invite your team later.</p>
      {params.error ? (
        <p className="form-error">Could not create that workspace. Try another name.</p>
      ) : null}
      <form className="auth-form" action={createInitialOrganization}>
        <label>
          Workspace name
          <input name="name" type="text" required minLength={2} maxLength={80} placeholder="e.g. Brian’s Collection" autoComplete="organization" />
        </label>
        <button type="submit">Create workspace</button>
      </form>
    </>
  );
}
