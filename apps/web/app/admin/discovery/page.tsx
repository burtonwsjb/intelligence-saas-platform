import {
  listDiscoveredCreators,
  listDiscoveryTopics,
  listDiscoveryRuns,
} from "@isp/db";
import { requireGrantedOperator } from "@/lib/platform-admin";
import {
  setDiscoveredCreatorStateAction,
  setDiscoveryTopicEnabledAction,
  triggerDiscoveryRunAction,
} from "@/app/admin-actions";

export const dynamic = "force-dynamic";

export default async function AdminDiscoveryPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; queued?: string }>;
}) {
  const operator = await requireGrantedOperator();
  const query = await searchParams;
  const db = operator.adminDb;
  if (!db) {
    return <p className="muted">Discovery needs the platform admin database role.</p>;
  }
  const [topics, creators, runs] = await Promise.all([listDiscoveryTopics(db), listDiscoveredCreators(db), listDiscoveryRuns(db)]);

  return (
    <>
      <h1>Discovery</h1>
      <p className="muted">
        Topic search discovers YouTube channels and Reddit accounts automatically. Channel ID lists are optional seeds,
        not required. Relevance is not the same as authority.
      </p>
      {query.error ? <p className="form-error">Discovery update was rejected.</p> : null}
      {query.queued === "yes" ? <p role="status">Discovery queued for the worker. Refresh to see results after processing.</p> : null}
      <h2>Recent runs</h2>
      <p className="muted">Discovery and creator polling are separate bounded operations. Accepted records still pass through normalization and identity checks.</p>
      {runs.length === 0 ? <p>No runs recorded yet.</p> : runs.map((run) => (
        <section key={run.id}>
          <p>{run.providerKey} · {run.metadata.activity === "monitoring" ? "Creator monitoring" : run.query} · {run.status}</p>
          <p className="muted">Started {run.startedAt.toISOString()} · accepted {run.contentIngested} · channels {run.channelsSeen} · HTTP requests {run.quotaUnits} · error {run.errorClass ?? "none"}</p>
        </section>
      ))}
      <h2>Topics</h2>
      <form className="inline-form" action={triggerDiscoveryRunAction}>
        <label>
          Provider
          <select name="providerKey" defaultValue="youtube">
            <option value="youtube">YouTube</option>
            <option value="reddit">Reddit</option>
          </select>
        </label>
        <label>
          Query
          <input name="query" defaultValue="Pokemon TCG investing" />
        </label>
        <label>
          Confirm bounded run
          <input type="checkbox" name="confirm" value="yes" required />
        </label>
        <button type="submit">Run discovery</button>
      </form>
      {topics.map((topic) => (
        <section key={topic.id}>
          <p>
            {topic.providerKey} · {topic.query} · {topic.enabled ? "enabled" : "paused"} · last run{" "}
            {topic.lastRunAt?.toISOString() ?? "—"}
          </p>
          <form className="inline-form" action={setDiscoveryTopicEnabledAction}>
            <input type="hidden" name="topicId" value={topic.id} />
            <input type="hidden" name="enabled" value={topic.enabled ? "false" : "true"} />
            <button type="submit">{topic.enabled ? "Disable topic" : "Enable topic"}</button>
          </form>
        </section>
      ))}
      <h2>Discovered creators</h2>
      {creators.length === 0 ? <p className="muted">No discovered creators yet.</p> : null}
      {creators.map((row) => (
        <section key={row.id}>
          <p>
            {row.displayName ?? row.externalAccountId} · {row.providerKey} · {row.relevanceState} · score{" "}
            {row.relevanceScore} · topics {row.topicHits} · reach views {row.reachViews ?? "—"}
          </p>
          <p className="muted">
            Last monitor success {row.lastMonitorSuccessAt?.toISOString() ?? "Not polled yet"} · next check{" "}
            {row.nextMonitorAt?.toISOString() ?? "Next scheduled cycle"} · monitoring error {row.monitorErrorClass ?? "none"}
          </p>
          <form className="inline-form" action={setDiscoveredCreatorStateAction}>
            <input type="hidden" name="id" value={row.id} />
            <label>
              State
              <select name="relevanceState" defaultValue={row.relevanceState}>
                <option value="candidate">candidate</option>
                <option value="monitored">monitored</option>
                <option value="low_confidence">low_confidence</option>
                <option value="excluded">excluded</option>
              </select>
            </label>
            <button type="submit">Update</button>
          </form>
        </section>
      ))}
    </>
  );
}
