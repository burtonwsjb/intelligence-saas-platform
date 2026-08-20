import { EmptyState } from "@/components/EmptyState";
import { Sparkline } from "@/components/Sparkline";
import { loadAppAccess } from "@/lib/app-access";
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
  await loadAppAccess();
  const { indexKey } = await params;
  const workspace = await getIndexWorkspace(getDb(), decodeURIComponent(indexKey));
  if (!workspace) {
    notFound();
  }
  const values = workspace.levels.map((level) => Number(level.indexValue));
  const members = await Promise.all(
    workspace.members.slice(0, 40).map(async (member) => ({
      member,
      identity: await getPrintingIdentity(getDb(), member.printingId),
    })),
  );

  return (
    <>
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
      <Sparkline values={values} label="index level" />
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
