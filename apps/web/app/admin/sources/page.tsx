import {
  PROVIDER_ADAPTER_NOTES,
  POKEMON_INFLUENCER_SEEDS,
  POKEMON_INFLUENCER_SEED_VERSION,
  collectSystemHealth,
  listAdminProviders,
  listInfluencerSeedStatus,
  listWebBackfillProgress,
  listWebFeedSites,
  listYoutubeBackfillProgress,
} from "@isp/db";
import { requireGrantedOperator } from "@/lib/platform-admin";
import { getDb } from "@/lib/auth";
import {
  registerWebFeedSiteAction,
  requestInfluencerSeedAction,
  retryProviderJobAction,
  setProviderEnabledAction,
  setProviderPausedAction,
  setWebFeedSiteStateAction,
  triggerProviderSyncAction,
} from "@/app/admin-actions";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function AdminSourcesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; website?: string; seed?: string; queued?: string; sites?: string }>;
}) {
  const operator = await requireGrantedOperator();
  const query = await searchParams;
  const db = operator.adminDb ?? getDb();
  const [health, providers, websites, seedRows, youtubeBackfill, webBackfill] = await Promise.all([
    collectSystemHealth(db),
    listAdminProviders(db),
    listWebFeedSites(db),
    listInfluencerSeedStatus(db),
    listYoutubeBackfillProgress(db),
    listWebBackfillProgress(db),
  ]);
  const seedCounts = seedRows.reduce<Record<string, number>>((acc, row) => {
    const key = `${row.kind}:${row.outcome ?? row.status}`;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <>
      <h1>Sources</h1>
      <p className="muted">
        Provider runtime, credentials status (never secret values), health, and staging sync.{" "}
        <Link href="/admin/quarantine">Quarantine</Link>
      </p>
      {query.error === "website_invalid" ? (
        <p className="form-error">Website rejected: use a public http(s) address of the creator&apos;s own site.</p>
      ) : query.error === "website_platform" ? (
        <p className="form-error">
          Website rejected: platforms and stores (YouTube, Reddit, marketplaces) are covered by their own providers.
        </p>
      ) : query.error === "seed_unconfirmed" ? (
        <p className="form-error">Type seed to confirm registering the influencer seed list.</p>
      ) : query.error ? (
        <p className="form-error">Source control was rejected.</p>
      ) : null}
      {query.website === "added" ? <p role="status">Website registered. The next hourly feed run reads it.</p> : null}
      {query.seed === "requested" ? (
        <p role="status">
          Seed list registered: {Number(query.queued ?? 0)} new YouTube channels queued for lookup, {Number(query.sites ?? 0)}{" "}
          new websites registered.
        </p>
      ) : null}
      {providers.map((row) => (
        <section key={row.providerKey}>
          <h2>{row.providerKey}</h2>
          <p>
            {row.providerType} · mode {row.mode} · {row.enabled ? "enabled" : "disabled"} ·{" "}
            {row.paused ? "paused" : "active"} · credentials {row.credentialStatus} · health {row.healthStatus}
          </p>
          <p className="muted">
            {PROVIDER_ADAPTER_NOTES[row.providerKey as keyof typeof PROVIDER_ADAPTER_NOTES] ?? ""}
          </p>
          <p className="muted">
            last success {row.lastSuccessAt?.toISOString() ?? "—"} · last attempt {row.lastAttemptAt?.toISOString() ?? "—"} ·
            error {row.lastErrorClass ?? "—"} · rate remaining {row.rateLimitRemaining ?? "—"} · ingested{" "}
            {row.recordsIngested} · quarantined {row.recordsQuarantined} · cursor {row.lastSourceId ?? "—"} · schedule{" "}
            {row.scheduleSeconds}s
          </p>
          <form className="inline-form" action={setProviderEnabledAction}>
            <input type="hidden" name="providerKey" value={row.providerKey} />
            <input type="hidden" name="enabled" value={row.enabled ? "false" : "true"} />
            <label>
              Reason
              <input name="reason" required />
            </label>
            <button type="submit">{row.enabled ? "Disable" : "Enable"}</button>
          </form>
          <form className="inline-form" action={setProviderPausedAction}>
            <input type="hidden" name="providerKey" value={row.providerKey} />
            <input type="hidden" name="paused" value={row.paused ? "false" : "true"} />
            <label>
              Reason
              <input name="reason" required />
            </label>
            <button type="submit">{row.paused ? "Resume" : "Pause"}</button>
          </form>
          <form className="inline-form" action={triggerProviderSyncAction}>
            <input type="hidden" name="providerKey" value={row.providerKey} />
            <label>
              Confirm staging sync
              <input type="checkbox" name="confirm" value="yes" required />
            </label>
            <button type="submit">Trigger staging sync</button>
          </form>
        </section>
      ))}
      <h2 id="websites">Influencer websites</h2>
      <p className="muted">
        Registered sites are read through their RSS or Atom feed by the web_feed provider (live mode only), honoring
        robots.txt. Card names in posts become mentions and creator calls for the site. Only short excerpts around card
        names are kept.
      </p>
      <form className="inline-form" action={registerWebFeedSiteAction}>
        <label>
          Website URL
          <input name="siteUrl" placeholder="https://pokeinsider.com/" required />
        </label>
        <label>
          Feed URL (optional)
          <input name="feedUrl" placeholder="https://example.com/feed" />
        </label>
        <label>
          Display name (optional)
          <input name="displayName" />
        </label>
        <button type="submit">Add website</button>
      </form>
      {websites.length === 0 ? <p className="muted">No websites registered yet.</p> : null}
      {websites.map((site) => (
        <section key={site.sourceAccountId}>
          <p>
            {site.displayName ?? site.domain} · {site.domain} · {site.state ?? "unknown"} · feed {site.feedUrl ?? "not found yet"}
          </p>
          <p className="muted">
            last check {site.lastCheckAt?.toISOString() ?? "not yet"} · {site.lastStatus ?? "—"} · outcome{" "}
            {site.lastOutcome ?? "—"} · new posts {site.lastNewPosts ?? "—"} · error {site.lastErrorClass ?? "—"}
          </p>
          <form className="inline-form" action={setWebFeedSiteStateAction}>
            <input type="hidden" name="sourceAccountId" value={site.sourceAccountId} />
            <input type="hidden" name="state" value={site.state === "paused" ? "active" : "paused"} />
            <button type="submit">{site.state === "paused" ? "Resume" : "Pause"}</button>
          </form>
        </section>
      ))}
      <h2 id="influencer-seed">Influencer seed list</h2>
      <p className="muted">
        {POKEMON_INFLUENCER_SEEDS.length} Pokemon influencers ({POKEMON_INFLUENCER_SEED_VERSION}). Registering is
        idempotent: websites are registered at once (shared platforms such as Patreon are reported, not registered);
        YouTube channels are looked up by the worker through the YouTube Data API, a few per scheduled run within the
        daily YouTube budget. Channels that cannot be resolved are reported here, never guessed. Excluded creators stay
        excluded.
      </p>
      <form className="inline-form" action={requestInfluencerSeedAction}>
        <label>
          Type seed to confirm
          <input name="confirm" autoComplete="off" required />
        </label>
        <button type="submit">Register seed list</button>
      </form>
      {seedRows.length === 0 ? (
        <p className="muted">Seed list not registered yet.</p>
      ) : (
        <>
          <p className="muted">
            {Object.entries(seedCounts)
              .sort()
              .map(([key, count]) => `${key} ${count}`)
              .join(" · ")}
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th>Rank</th>
                <th>Name</th>
                <th>Kind</th>
                <th>Input</th>
                <th>State</th>
                <th>Account</th>
              </tr>
            </thead>
            <tbody>
              {seedRows.map((row) => (
                <tr key={row.id}>
                  <td>{row.rank}</td>
                  <td>{row.name}</td>
                  <td>{row.kind}</td>
                  <td>{row.input ?? "—"}</td>
                  <td>
                    {row.outcome ?? row.status}
                    {row.errorClass ? ` (${row.errorClass})` : ""}
                  </td>
                  <td>{row.externalAccountId ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <h2 id="backfill">12-month backfill</h2>
      <p className="muted">
        YouTube uploads (titles and descriptions only, official Data API) run when YOUTUBE_BACKFILL_DAYS is set; website
        sitemaps run when WEB_FEED_BACKFILL_DAYS is set. Both resume where they stopped.
      </p>
      {youtubeBackfill.length === 0 ? <p className="muted">No YouTube backfill runs yet.</p> : null}
      <ul>
        {youtubeBackfill.map((row) => (
          <li key={row.channelId}>
            YouTube {row.channelId} · {row.done ? "done" : "in progress"} · {row.outcome ?? "—"} · pages {row.pages} ·
            videos {row.videosStored} · mentions {row.mentions} · calls {row.callsCreated} · last run{" "}
            {row.lastRunAt?.toISOString() ?? "—"}
          </li>
        ))}
      </ul>
      {webBackfill.length === 0 ? <p className="muted">No website backfill runs yet.</p> : null}
      <ul>
        {webBackfill.map((row) => (
          <li key={row.sourceAccountId}>
            {row.domain ?? row.sourceAccountId} · {row.phase} · {row.outcome ?? "—"} · URLs {row.urlsFound} (queued{" "}
            {row.urlsQueued}) · posts {row.postsIngested} · mentions {row.mentions} · calls {row.callsCreated} · last run{" "}
            {row.lastRunAt?.toISOString() ?? "—"}
          </li>
        ))}
      </ul>
      <h2>Retry failed job</h2>
      <form className="inline-form" action={retryProviderJobAction}>
        <label>
          Job id
          <input name="jobId" required />
        </label>
        <label>
          Reason
          <input name="reason" required />
        </label>
        <button type="submit">Retry</button>
      </form>
      <h2>Ingest status</h2>
      <ul>
        {health.ingestByStatus.map((row) => (
          <li key={row.key}>
            {row.key}: {row.count}
          </li>
        ))}
      </ul>
    </>
  );
}
