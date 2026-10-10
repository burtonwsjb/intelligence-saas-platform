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
  evaluateQuota,
  loadEntitlement,
  resolveBillingMode,
  type EntitlementKey,
} from "@isp/billing";
import { and, eq } from "drizzle-orm";
import { openBillingPortal, startCheckout } from "@/app/billing-actions";

export const dynamic = "force-dynamic";

const ENTITLEMENT_LABEL: Record<string, string> = {
  api_requests_per_month: "API requests a month",
  api_keys: "API keys",
  team_members: "Team members",
  webhooks: "Webhooks",
  alerts: "Watchlist alerts",
  predictions: "Forecasts",
  creator_analytics: "Creator accuracy and leaderboard",
};

const STATUS_TEXT: Record<string, string> = {
  trialing: "Free trial",
  active: "Active",
  past_due: "Payment past due",
  canceled: "Canceled",
  incomplete: "Payment incomplete",
};

const PAID_PLANS = ["starter", "growth", "scale"] as const;

function entitlementText(value: { enabled: boolean; kind: string; limit: number | null }): string {
  if (!value.enabled) return "Not included";
  if (value.kind === "limit") return value.limit == null ? "Unlimited" : value.limit.toLocaleString("en-US");
  return "Included";
}

function formatDay(value: Date): string {
  return value.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

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

  const currentPlan = snapshot.billing?.planKey ?? "free";
  const status = snapshot.billing?.status ?? null;
  const planName = (key: string) => snapshot.catalog.plans.find((plan) => plan.key === key)?.name ?? key;
  const usageLimit = Number.isFinite(snapshot.usage.limit) ? snapshot.usage.limit : null;
  const usageShare = usageLimit ? Math.min(1, snapshot.usage.current / usageLimit) : 0;

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Account</p>
          <h1>Plan and billing</h1>
          <p className="muted">What your workspace includes, how much of it you have used, and how to change plan.</p>
        </div>
      </header>
      {billingMode === "local_simulation" ? (
        <p className="notice">Test mode: no card is charged and plan changes are simulated.</p>
      ) : null}
      {query.error ? <p className="form-error">That billing action was not allowed or is not set up yet.</p> : null}
      {query.checkout === "return" ? (
        <p className="notice">Thanks. Your plan updates here as soon as the payment is confirmed.</p>
      ) : null}

      <div className="panel-grid">
        <section className="panel" aria-labelledby="current-plan-heading">
          <p className="eyebrow" id="current-plan-heading">
            Current plan
          </p>
          <p className="stat-value">{planName(currentPlan)}</p>
          <p className="muted" style={{ margin: 0 }}>
            {status && status !== "none" ? STATUS_TEXT[status] ?? status.replaceAll("_", " ") : "No paid subscription"}
            {snapshot.billing?.trialEndsAt ? ` · trial ends ${formatDay(snapshot.billing.trialEndsAt)}` : ""}
          </p>
          <dl className="kv" style={{ marginTop: "var(--space-4)" }}>
            {snapshot.entitlements.map((row) => (
              <div key={row.key} style={{ display: "contents" }}>
                <dt>{ENTITLEMENT_LABEL[row.key] ?? row.key}</dt>
                <dd>{entitlementText(row.value)}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="panel" aria-labelledby="usage-heading">
          <p className="eyebrow" id="usage-heading">
            API use this period
          </p>
          <p className="stat-value">
            {snapshot.usage.current.toLocaleString("en-US")}
            <span className="subtle"> / {usageLimit == null ? "unlimited" : usageLimit.toLocaleString("en-US")}</span>
          </p>
          {usageLimit ? (
            <div
              className="meter"
              role="meter"
              aria-label="API requests used"
              aria-valuemin={0}
              aria-valuemax={usageLimit}
              aria-valuenow={snapshot.usage.current}
            >
              <span style={{ width: `${usageShare * 100}%` }} />
            </div>
          ) : null}
          <p className="subtle" style={{ marginBottom: 0 }}>
            If a payment lapses your data is kept and the workspace falls back to the Free plan.
          </p>
        </section>
      </div>

      <h2>Plans</h2>
      <ul className="plan-grid">
        {snapshot.catalog.plans.map((plan) => {
          const price = PLAN_PRICE_DISPLAY[plan.key as keyof typeof PLAN_PRICE_DISPLAY];
          const isCurrent = plan.key === currentPlan;
          const features = DISPLAY_KEYS.map((key) => {
            const row = snapshot.catalog.entitlements.find(
              (item) => item.planKey === plan.key && item.entitlementKey === key,
            );
            return {
              key,
              text: entitlementText({
                enabled: row?.enabled ?? false,
                kind: row?.valueKind ?? "boolean",
                limit: row?.limitValue ?? null,
              }),
            };
          });
          return (
            <li key={plan.key} className={`panel plan-card${isCurrent ? " current" : ""}`}>
              <h3>{plan.name}</h3>
              <p className="plan-price">{plan.key === "free" ? "$0" : price?.configured ? price.label : "Pricing coming soon"}</p>
              <ul className="plan-features">
                {features.map((feature) => (
                  <li key={feature.key} className={feature.text === "Not included" ? "off" : undefined}>
                    <span>{ENTITLEMENT_LABEL[feature.key] ?? feature.key}</span>
                    <span>{feature.text}</span>
                  </li>
                ))}
              </ul>
              {isCurrent ? (
                <p className="plan-current">Your plan</p>
              ) : canBill && (PAID_PLANS as readonly string[]).includes(plan.key) ? (
                <form action={startCheckout}>
                  <input type="hidden" name="planKey" value={plan.key} />
                  <button className="button" type="submit">
                    Choose {plan.name}
                  </button>
                </form>
              ) : null}
            </li>
          );
        })}
      </ul>

      {canBill ? (
        <form action={openBillingPortal} style={{ marginTop: "var(--space-4)" }}>
          <button className="button secondary" type="submit">
            Manage payment details and invoices
          </button>
        </form>
      ) : (
        <p className="muted">Only workspace owners and billing admins can change the plan.</p>
      )}
    </>
  );
}
