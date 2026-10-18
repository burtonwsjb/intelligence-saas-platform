import { EmptyState, LockedFeature } from "@/components/EmptyState";
import { PriceTrendChart } from "@/components/PriceTrendChart";
import { ANALYTICS_LOCKED_BODY, loadAppAccess } from "@/lib/app-access";
import { getDb } from "@/lib/auth";
import { getIndexWorkspace, getPrintingIdentity } from "@isp/db";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function IndexDetailPage({
  params,
}: {
  params: Promise<{ indexKey: string }>;
}) {
  const { access } = await loadAppAccess();
  if (!access.canViewAnalytics) {
    return <LockedFeature title="Index" body={ANALYTICS_LOCKED_BODY} />;
  }
  const { indexKey } = await params;
  const workspace = await getIndexWorkspace(getDb(), decodeURIComponent(indexKey));
  if (!workspace) {
    notFound();
  }
  const points = workspace.levels.map((level) => ({ observedAt: level.observedAt, amount: Number(level.indexValue) }));
  const members = await Promise.all(
    workspace.members.slice(0, 40).map(async (member) => ({
      member,
      identity: await getPrintingIdentity(getDb(), member.printingId),
    })),
  );

  return (
    <>
      <p style={{ margin: "0 0 var(--space-3)" }}>
        <Link className="text-link" href="/app/markets">
          ← Back to markets
        </Link>
      </p>
      <h1>{workspace.definition.name}</h1>
      <p>
        {workspace.definition.gameKey}
        {workspace.definition.languageCode ? ` · ${workspace.definition.languageCode}` : ""} · weighting{" "}
        {workspace.definition.weightingMethod} · method {workspace.definition.methodVersion}
      </p>
      <p>
        Latest: {workspace.latest ? Number(workspace.latest.indexValue).toFixed(4) : "—"} · coverage{" "}
        {workspace.latest?.coverage ?? "—"} · quality {workspace.latest?.dataQuality ?? "—"} · return{" "}
        {workspace.returnPct == null ? "—" : `${(workspace.returnPct * 100).toFixed(2)}%`}
      </p>
      <section className="panel">
        <PriceTrendChart points={points} title={`${workspace.definition.name} level`} caption="Index level over time, positioned by observation date." />
      </section>
      <h2>Membership</h2>
      {members.length === 0 ? (
        <EmptyState title="No members as of latest level" body="Rebalance jobs populate membership." />
      ) : (
        <ul>
          {members.map(({ member, identity }) => (
            <li key={member.id}>
              {identity ? (
                <Link href={`/app/cards/${identity.printingId}`}>
                  {identity.cardName} · {identity.languageCode} · {identity.variantKey}
                </Link>
              ) : (
                member.printingId
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
