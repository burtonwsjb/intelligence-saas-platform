import { EmptyState } from "@/components/EmptyState";
import { PrintingWorkspaceView } from "@/components/PrintingWorkspaceView";
import { loadAppAccess } from "@/lib/app-access";
import { getDb } from "@/lib/auth";
import { getPrintingWorkspace, publishedPredictionsForCustomer } from "@isp/db";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function OpportunityDetailPage({
  params,
}: {
  params: Promise<{ printingId: string }>;
}) {
  const { access } = await loadAppAccess();
  const { printingId } = await params;
  const workspace = await getPrintingWorkspace(getDb(), printingId);
  if (!workspace) {
    notFound();
  }
  const visible = publishedPredictionsForCustomer(workspace.predictions, {
    entitled: access.hasPredictionsEntitlement,
    flagEnabled: access.predictionsCustomerVisible,
  });
  const locked =
    access.hasPredictionsEntitlement && access.predictionsCustomerVisible
      ? null
      : "Customer forecasts are disabled (shadow default). Enable entitlement plus PREDICTIONS_CUSTOMER_VISIBLE to view published predictions.";

  return (
    <>
      <h1>Opportunity</h1>
      {workspace.score ? null : (
        <EmptyState title="No score yet" body="Market identity is still shown. Scoring jobs fill opportunity components." />
      )}
      <PrintingWorkspaceView workspace={workspace} predictions={visible} predictionLocked={locked} />
    </>
  );
}
