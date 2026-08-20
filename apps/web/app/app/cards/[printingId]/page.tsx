import { EmptyState } from "@/components/EmptyState";
import { PrintingWorkspaceView } from "@/components/PrintingWorkspaceView";
import { loadAppAccess } from "@/lib/app-access";
import { getDb } from "@/lib/auth";
import { getPrintingWorkspace, publishedPredictionsForCustomer } from "@isp/db";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function PrintingDetailPage({
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
  return (
    <>
      <h1>Printing</h1>
      {workspace.latestSold ? null : (
        <EmptyState title="No sold history yet" body="Identity remains visible. Market jobs fill price series." />
      )}
      <PrintingWorkspaceView
        workspace={workspace}
        predictions={visible}
        predictionLocked={
          access.hasPredictionsEntitlement && access.predictionsCustomerVisible
            ? null
            : "Published customer forecasts are not enabled for this tenant."
        }
      />
    </>
  );
}
