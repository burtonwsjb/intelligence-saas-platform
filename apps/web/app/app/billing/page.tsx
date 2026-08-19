import { requirePageOrganization } from "@/lib/session";
import { getDb } from "@/lib/auth";
import { getTenantBilling, member, withOrganizationContext } from "@isp/db";
import { hasPermission } from "@isp/auth";
import { and, eq } from "drizzle-orm";
import { openBillingPortal, startCheckout } from "@/app/billing-actions";

export const dynamic = "force-dynamic";

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; checkout?: string }>;
}) {
  const { session, organizationId } = await requirePageOrganization();
  const query = await searchParams;
  const [membership] = await getDb()
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, session.user.id)))
    .limit(1);
  const canBill = hasPermission(membership?.role, "canManageBilling");
  const billing = await withOrganizationContext(
    getDb(),
    { organizationId, userId: session.user.id },
    (scoped) => getTenantBilling(scoped, organizationId),
  );

  return (
    <>
      <h1>Billing</h1>
      <p>Plan: {billing?.planKey ?? "free"}</p>
      <p>Subscription status: {billing?.status ?? "none"}</p>
      <p className="muted">
        Local billing simulation is the default. Hosted Stripe Checkout and Customer
        Portal are deferred and fail closed until Stripe test mode is configured later.
      </p>
      {query.error ? <p className="form-error">Billing action was denied or not configured.</p> : null}
      {query.checkout === "return" ? (
        <p className="muted">Returned from Stripe. Subscription state updates via webhook.</p>
      ) : null}
      {canBill ? (
        <>
          <form className="auth-form" action={startCheckout}>
            <label>
              Plan
              <select name="planKey">
                <option value="starter">starter</option>
                <option value="growth">growth</option>
                <option value="scale">scale</option>
              </select>
            </label>
            <button type="submit">Start Stripe test checkout</button>
          </form>
          <form action={openBillingPortal}>
            <button type="submit">Open customer portal</button>
          </form>
        </>
      ) : (
        <p className="muted">Billing actions are limited to owner and billing roles.</p>
      )}
    </>
  );
}
