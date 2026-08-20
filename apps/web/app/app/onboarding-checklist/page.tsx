import { betaOrganization, ONBOARDING_STEPS, withOrganizationContext } from "@isp/db";
import { getDb } from "@/lib/auth";
import { loadAppAccess } from "@/lib/app-access";
import { saveUseCaseAction } from "@/app/beta-actions";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export default async function OnboardingChecklistPage() {
  const { organizationId, userId } = await loadAppAccess();
  const profile = await withOrganizationContext(
    getDb(),
    { organizationId, userId },
    async (scoped) => {
      const [row] = await scoped
        .select()
        .from(betaOrganization)
        .where(eq(betaOrganization.organizationId, organizationId))
        .limit(1);
      return row;
    },
  );
  const onboarding = (profile?.onboarding ?? {}) as Record<string, unknown>;

  return (
    <>
      <h1>Beta onboarding</h1>
      <p className="muted">
        Track activation. Market catalog data is fixture/sandbox unless a data provider is
        separately authorized.
      </p>
      <ul>
        {ONBOARDING_STEPS.map((step) => (
          <li key={step}>
            {onboarding[step] ? "done" : "open"} — {step.replaceAll("_", " ")}
          </li>
        ))}
      </ul>
      <form className="auth-form" action={saveUseCaseAction}>
        <label>
          Use case
          <input name="useCase" defaultValue={String(profile?.useCase ?? "")} maxLength={200} />
        </label>
        <button type="submit">Save use case</button>
      </form>
    </>
  );
}
