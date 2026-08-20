import { IdentityLine } from "@/components/IdentityLine";
import { Sparkline } from "@/components/Sparkline";
import type { getPrintingWorkspace } from "@isp/db";

type Workspace = NonNullable<Awaited<ReturnType<typeof getPrintingWorkspace>>>;

function num(value: string | number | null | undefined): string {
  if (value == null || value === "") return "—";
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : String(value);
}

export function PrintingWorkspaceView({
  workspace,
  predictions,
  predictionLocked,
}: {
  workspace: Workspace;
  predictions: Workspace["predictions"];
  predictionLocked?: string | null;
}) {
  const soldPrices = workspace.sold
    .map((row) => Number(row.price))
    .filter((value) => Number.isFinite(value));
  const explanations = Array.isArray(workspace.score?.explanations) ? workspace.score.explanations : [];
  const components = workspace.score?.components ?? {};
  const features = workspace.features?.features ?? {};

  return (
    <article className="workspace">
      <p>
        <IdentityLine identity={workspace.identity} />
      </p>
      <p className="muted">
        {workspace.identity.gameKey} · {workspace.identity.canonicalPrintingKey}
        {workspace.identity.rarity ? ` · ${workspace.identity.rarity}` : ""}
        {workspace.identity.finish ? ` · ${workspace.identity.finish}` : ""}
      </p>
      <section>
        <h2>Market</h2>
        <p>Latest sold: {num(workspace.latestSold?.price)} {workspace.latestSold?.currency ?? ""}</p>
        <p>Reference: {num(workspace.reference?.price)} {workspace.reference?.currency ?? ""}</p>
        <p>
          Listing supply: {workspace.listing?.listingCount ?? "—"} · sellers {workspace.listing?.sellerCount ?? "—"}
        </p>
        <p>Spread: {num(workspace.spread?.spread_abs)}</p>
        <Sparkline values={soldPrices} label="sold history" />
      </section>
      <section>
        <h2>Opportunity</h2>
        {workspace.score ? (
          <>
            <p>
              Opportunity {num(workspace.score.opportunityScore)} · Risk {num(workspace.score.riskScore)} ·
              Confidence {num(workspace.score.confidenceScore)} · Liquidity {num(workspace.score.liquidityScore)}
            </p>
            <p>
              Recommendation: {workspace.score.recommendation} · as of {workspace.score.asOf.toISOString()} · quality{" "}
              {workspace.score.dataQuality}
            </p>
            <h3>Why</h3>
            <ul>
              {explanations.map((item, index) => (
                <li key={index}>{typeof item === "string" ? item : JSON.stringify(item)}</li>
              ))}
            </ul>
            <h3>Components</h3>
            <pre className="json-block">{JSON.stringify(components, null, 2)}</pre>
          </>
        ) : (
          <p className="muted">No score snapshot yet.</p>
        )}
      </section>
      <section>
        <h2>Market features</h2>
        {workspace.features ? (
          <>
            <p>
              Sample size {workspace.features.sampleSize} · quality {workspace.features.dataQuality} · as of{" "}
              {workspace.features.asOf.toISOString()}
            </p>
            <pre className="json-block">{JSON.stringify(features, null, 2)}</pre>
          </>
        ) : (
          <p className="muted">No feature snapshot yet.</p>
        )}
      </section>
      <section>
        <h2>Creator calls</h2>
        {workspace.calls.length === 0 ? (
          <p className="muted">No resolved creator calls on this printing.</p>
        ) : (
          <ul>
            {workspace.calls.map((call) => (
              <li key={call.id}>
                {call.direction} · {call.horizonCode} · {call.publishedAt.toISOString()} · printing{" "}
                {call.printingId}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2>Predictions</h2>
        {predictionLocked ? (
          <p className="muted">{predictionLocked}</p>
        ) : predictions.length === 0 ? (
          <p className="muted">No published customer forecasts for this printing.</p>
        ) : (
          <ul>
            {predictions.map((row) => (
              <li key={row.id}>
                {row.horizon} · expected {num(row.expectedReturn)} · confidence {num(row.confidence)} · issued{" "}
                {row.issuedAt.toISOString()}
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}
