import { redirect } from "next/navigation";

// One canonical exact-printing page lives under Cards.
export default async function OpportunityDetailPage({ params }: { params: Promise<{ printingId: string }> }) {
  const { printingId } = await params;
  redirect(`/app/cards/${encodeURIComponent(printingId)}`);
}
