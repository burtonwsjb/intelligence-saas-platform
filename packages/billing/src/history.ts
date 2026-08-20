import { listCustomerEvents, type Database } from "@isp/db";

const BILLING_EVENT_TYPES = new Set([
  "subscription.started",
  "subscription.changed",
  "payment_failed",
  "subscription.canceled",
  "customer.reactivated",
]);

export async function listBillingHistory(
  scoped: Database,
  organizationId: string,
) {
  const events = await listCustomerEvents(scoped, { organizationId, limit: 100 });
  return events.filter((event) => BILLING_EVENT_TYPES.has(event.eventType));
}
