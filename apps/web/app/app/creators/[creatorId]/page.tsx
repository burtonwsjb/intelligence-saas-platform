import { EmptyState, LockedFeature } from "@/components/EmptyState";
import { loadAppAccess } from "@/lib/app-access";
import { getDb } from "@/lib/auth";
import { getCreatorAuthorityProfile } from "@isp/db";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function CreatorDetailPage({
  params,
}: {
  params: Promise<{ creatorId: string }>;
}) {
  const { access } = await loadAppAccess();
  if (!access.hasCreatorAnalytics) {
    return (
      <LockedFeature
        title="Creator"
        body="Creator analytics are not entitled on this plan."
      />
    );
  }
  const { creatorId } = await params;
  const profile = await getCreatorAuthorityProfile(getDb(), creatorId);
  if (!profile.creator) {
    notFound();
  }
  const headline = profile.headline;
  const sample = headline?.sampleSize ?? String(profile.resolved);

  return (
    <>
      <h1>{profile.creator.displayName ?? profile.creator.id}</h1>
      <p>Trust: {profile.trustState}</p>
      <p>
        Sample size {sample} · resolved {profile.resolved} / {profile.totalCalls} calls · awaiting outcome{" "}
        {profile.awaitingOutcome}
      </p>
      {headline ? (
        <>
          <p>
            Accuracy (Wilson, n={headline.sampleSize}): {headline.wilsonLow ?? "—"} – {headline.wilsonCenter ?? "—"} –{" "}
            {headline.wilsonHigh ?? "—"}
          </p>
          <p>Bayes mean: {headline.bayesMean ?? "—"} · early-call score: {headline.earlyCallScore ?? "—"}</p>
          <p>
            Avg return {headline.avgReturn ?? profile.averageReturn ?? "—"} · median{" "}
            {headline.medianReturn ?? profile.medianReturn ?? "—"} · relative {headline.avgRelativeReturn ?? "—"}
          </p>
          <p>Authority {headline.authorityScore} · specialization {headline.gameKey ?? "all games"} / {headline.languageCode ?? "all languages"} / {headline.horizonCode ?? "all horizons"}</p>
        </>
      ) : (
        <EmptyState title="Insufficient sample" body="No authority slice yet. Hit rate is omitted until n is available." />
      )}
      <h2>Best / worst evaluated calls</h2>
      <p>Best: {profile.bestCall?.id ?? "—"} · Worst: {profile.worstCall?.id ?? "—"}</p>
      <h2>Performance slices</h2>
      <ul>
        {profile.slices.map((slice) => (
          <li key={slice.id}>
            {slice.gameKey ?? "all"} / {slice.languageCode ?? "all"} / {slice.horizonCode ?? "all"} · n={slice.sampleSize} ·
            Wilson {slice.wilsonCenter ?? "—"} · alpha-related return {slice.avgRelativeReturn ?? "—"}
          </li>
        ))}
      </ul>
      <h2>Calls</h2>
      <ul>
        {profile.historicalCalls.map((row) => (
          <li key={row.call.id}>
            {row.call.direction} · {row.call.horizonCode} · printing {row.call.printingId ?? "unresolved"} · outcome{" "}
            {row.outcome?.evaluationStatus ?? "none"}
            {row.outcome?.returnPct ? ` · return ${row.outcome.returnPct}` : ""}
          </li>
        ))}
      </ul>
      <p className="muted">Creator authority does not emit a buy/sell signal ({String(profile.buySellSignal)}).</p>
    </>
  );
}
