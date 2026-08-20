import { requirePageOrganization } from "@/lib/session";
import { getDb } from "@/lib/auth";
import {
  getTenantBilling,
  listPlanCatalog,
  member,
  withOrganizationContext,
} from "@isp/db";
import { hasPermission } from "@isp/auth";
import {
  PLAN_PRICE_DISPLAY,
  RETENTION_POLICY,
  evaluateQuota,
  loadEntitlement,
  resolveBillingMode,
  type EntitlementKey,
} from "@isp/billing";
import { and, eq } from "drizzle-orm";
import { openBillingPortal, startCheckout } from "@/app/billing-actions";

export const dynamic = "force-dynamic";

const DISPLAY_KEYS: EntitlementKey[] = [
  "api_requests_per_month",
  "api_keys",
  "webhooks",
  "alerts",
  "predictions",
  "creator_analytics",
];

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
  const billingMode = resolveBillingMode();
  const snapshot = await withOrganizationContext(
    getDb(),
    { organizationId, userId: session.user.id },
    async (scoped) => {
      const billing = await getTenantBilling(scoped, organizationId);
      const catalog = await listPlanCatalog(scoped);
      const entitlements = await Promise.all(
        DISPLAY_KEYS.map(async (key) => ({ key, value: await loadEntitlement(scoped, organizationId, key) })),
      );
      const usage = await evaluateQuota(scoped, { organizationId, meterKey: "api.reads" });
      return { billing, catalog, entitlements, usage };
    },
  );

  return (
    <>
      <h1>Billing</h1>
      {billingMode === "local_simulation" ? (
        <p className="muted">
          Local billing simulation is active. No real charges. Hosted Stripe Checkout remains
          deferred. Plan prices are configuration/TBD and are not production prices.
        </p>
      ) : null}
      <p>Plan: {snapshot.billing?.planKey ?? "free"}</p>
      <p>Subscription status: {snapshot.billing?.status ?? "none"}</p>
      <p>
        Trial:{" "}
        {snapshot.billing?.trialStartedAt
          ? `${snapshot.billing.trialStartedAt.toISOString()} → ${snapshot.billing.trialEndsAt?.toISOString() ?? "open"}`
          : "not in trial"}
      </p>
      <p className="muted">
        Past-due and canceled accounts keep data ({RETENTION_POLICY.version}). Entitlements fall back
        to free. Data is not deleted.
      </p>
      <h2>Entitlements</h2>
      <ul>
        {snapshot.entitlements.map((row) => (
          <li key={row.key}>
            {row.key}: {row.value.enabled ? "enabled" : "disabled"}
            {row.value.kind === "limit" ? ` (limit ${row.value.limit})` : ""}
          </li>
        ))}
      </ul>
      <h2>Usage</h2>
      <p>
        API reads this period: {snapshot.usage.current} / {Number.isFinite(snapshot.usage.limit) ? snapshot.usage.limit : "unlimited"} ({snapshot.usage.remaining} remaining)
      </p>
      <h2>Plans</h2>
      <ul>
        {snapshot.catalog.plans.map((plan) => (
          <li key={plan.key}>
            {plan.name} — {PLAN_PRICE_DISPLAY[plan.key as keyof typeof PLAN_PRICE_DISPLAY]?.label ?? "TBD"}
          </li>
        ))}
      </ul>
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
