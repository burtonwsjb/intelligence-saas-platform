import { EmptyState, LockedFeature } from "@/components/EmptyState";
import { loadAppAccess } from "@/lib/app-access";
import { getDb } from "@/lib/auth";
import { publishedPredictionsForCustomer, tcgPrediction } from "@isp/db";
import { desc } from "drizzle-orm";
import Link from "next/link";
import { IntelligenceDisclaimer } from "@/components/IntelligenceDisclaimer";

export const dynamic = "force-dynamic";

export default async function PredictionsPage() {
  const { access } = await loadAppAccess();
  if (!access.hasPredictionsEntitlement || !access.predictionsCustomerVisible) {
    return (
      <LockedFeature
        title="Predictions"
        body="Customer-facing forecasts stay disabled while predictions run in shadow mode. This page does not publish shadow rows. Set PREDICTIONS_CUSTOMER_VISIBLE=true and entitle predictions to preview published forecasts only."
      />
    );
  }
  const rows = await getDb().select().from(tcgPrediction).orderBy(desc(tcgPrediction.issuedAt));
  const visible = publishedPredictionsForCustomer(rows, {
    entitled: true,
    flagEnabled: true,
  });

  return (
    <>
      <h1>Predictions</h1>
      <IntelligenceDisclaimer />
      <p className="muted">Only visibility=published forecasts are listed. Shadow rows stay internal.</p>
      {visible.length === 0 ? (
        <EmptyState
          title="No published forecasts"
          body="Local models still issue shadow predictions. They are not shown here."
        />
      ) : (
        <ul>
          {visible.map((row) => (
            <li key={row.id}>
              <Link href={`/app/cards/${row.printingId}`}>
                {row.printingId} · {row.horizon} · {row.issuedAt.toISOString()}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
