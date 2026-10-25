import {
  PROVIDER_ADAPTER_NOTES,
  POKEMON_INFLUENCER_SEEDS,
  POKEMON_INFLUENCER_SEED_VERSION,
  collectSystemHealth,
  listAdminProviders,
  listInfluencerSeedStatus,
  listPodcastFeeds,
  listTikTokAccounts,
  listWebBackfillProgress,
  listWebFeedSites,
  listYoutubeBackfillProgress,
} from "@isp/db";
import { requireGrantedOperator } from "@/lib/platform-admin";
import { getDb } from "@/lib/auth";
import {
  addTikTokVideoLinksAction,
  followTikTokCreatorAction,
  registerPodcastFeedAction,
  registerWebFeedSiteAction,
  requestInfluencerSeedAction,
  retryProviderJobAction,
  setProviderEnabledAction,
  setProviderPausedAction,
  setPodcastFeedStateAction,
  setTikTokFollowStateAction,
  setWebFeedSiteStateAction,
  triggerProviderSyncAction,
} from "@/app/admin-actions";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function AdminSourcesPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    website?: string;
    podcast?: string;
    tiktok?: string;
    added?: string;
    duplicates?: string;
    rejected?: string;
    seed?: string;
    queued?: string;
    sites?: string;
  }>;
}) {
  const operator = await requireGrantedOperator();
  const query = await searchParams;
  const db = operator.adminDb ?? getDb();
  const [health, providers, websites, podcasts, tiktokAccounts, seedRows, youtubeBackfill, webBackfill] = await Promise.all([
    collectSystemHealth(db),
    listAdminProviders(db),
    listWebFeedSites(db),
    listPodcastFeeds(db),
    listTikTokAccounts(db),
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
      ) : query.error === "podcast_invalid" ? (
        <p className="form-error">Podcast rejected: use the public http(s) address of the podcast&apos;s RSS feed.</p>
      ) : query.error === "tiktok_migration_missing" ? (
        <p className="form-error">TikTok needs database update 0039_tiktok_source before links can be added.</p>
      ) : query.error === "tiktok_invalid_profile" ? (
        <p className="form-error">Paste a TikTok profile link, like https://www.tiktok.com/@creator.</p>
      ) : query.error?.startsWith("tiktok_") ? (
        <p className="form-error">Paste between 1 and 100 TikTok video links (tiktok.com/@name/video/…).</p>
      ) : query.error === "seed_unconfirmed" ? (
        <p className="form-error">Type seed to confirm registering the influencer seed list.</p>
      ) : query.error ? (
        <p className="form-error">Source control was rejected.</p>
      ) : null}
      {query.website === "added" ? <p role="status">Website registered. The next hourly feed run reads it.</p> : null}
      {query.podcast === "added" ? <p role="status">Podcast registered. The next hourly feed run reads it.</p> : null}
      {query.tiktok === "added" ? (
        <p role="status">
          TikTok links: {Number(query.added ?? 0)} added, {Number(query.duplicates ?? 0)} already there,{" "}
          {Number(query.rejected ?? 0)} not recognized as video links.
        </p>
      ) : null}
      {query.tiktok === "followed" ? (
        <p role="status">TikTok creator followed. The next hourly run lists their videos and keeps the card ones.</p>
      ) : null}
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
      <h2 id="podcasts">Podcasts</h2>
      <p className="muted">
        Registered podcast feeds are read by the web_feed provider (live mode only). Each episode from the last
        PODCAST_BACKFILL_DAYS days (default 365) is stored with its audio link and waits for the local Whisper helper,
        which downloads the episode file the podcast publishes, transcribes it at night and sends back the text. Card
        names in show notes and transcripts become mentions and calls; only short excerpts around card names are kept.
      </p>
      <form className="inline-form" action={registerPodcastFeedAction}>
        <label>
          RSS feed URL
          <input name="feedUrl" placeholder="https://feeds.example.com/show.xml" required />
        </label>
        <label>
          Display name (optional)
          <input name="displayName" />
        </label>
        <button type="submit">Add podcast</button>
      </form>
      {podcasts.length === 0 ? <p className="muted">No podcasts registered yet.</p> : null}
      {podcasts.map((podcast) => (
        <section key={podcast.sourceAccountId}>
          <p>
            {podcast.displayName ?? podcast.feedUrl} · {podcast.state ?? "unknown"} · episodes {podcast.episodes} ·
            transcribed {podcast.transcribed} · waiting {podcast.waiting}
          </p>
          <p className="muted">
            feed {podcast.feedUrl ?? "—"} · last check {podcast.lastCheckAt?.toISOString() ?? "not yet"} ·{" "}
            {podcast.lastStatus ?? "—"} · outcome {podcast.lastOutcome ?? "—"} · error {podcast.lastErrorClass ?? "—"}
          </p>
          <form className="inline-form" action={setPodcastFeedStateAction}>
            <input type="hidden" name="sourceAccountId" value={podcast.sourceAccountId} />
            <input type="hidden" name="state" value={podcast.state === "paused" ? "active" : "paused"} />
            <button type="submit">{podcast.state === "paused" ? "Resume" : "Pause"}</button>
          </form>
        </section>
      ))}
      <h2 id="tiktok">TikTok creators</h2>
      <p className="muted">
        Follow a creator by pasting their profile link. Every 12 hours the worker lists their newest videos through
        ScrapeCreators (PROVIDER_TIKTOK_MODE=live, SCRAPECREATORS_API_KEY), reads each caption and keeps only the videos
        about cards: a card name, or words like pokemon, booster, PSA or pulls. The first check goes back a year. Kept
        videos get transcripts from the transcript service (TRANSCRIPT_PROVIDER=supadata) in the hourly transcript run,
        and card names become calls. You can also paste single video links. Sentiment never downloads TikTok videos.
      </p>
      <form className="inline-form" action={followTikTokCreatorAction}>
        <label>
          Profile link
          <input name="profile" required placeholder="https://www.tiktok.com/@creator" />
        </label>
        <label>
          Display name (optional)
          <input name="displayName" />
        </label>
        <button type="submit">Follow creator</button>
      </form>
      <form className="inline-form" action={addTikTokVideoLinksAction}>
        <label>
          Single video links (one per line)
          <textarea name="links" rows={3} required placeholder="https://www.tiktok.com/@creator/video/7400000000000000000" />
        </label>
        <label>
          Display name (optional)
          <input name="displayName" />
        </label>
        <button type="submit">Add videos</button>
      </form>
      {tiktokAccounts.length === 0 ? <p className="muted">No TikTok creators yet.</p> : null}
      {tiktokAccounts.map((account) => (
        <section key={account.sourceAccountId}>
          <h3>
            {account.displayName ?? `@${account.handle}`} · @{account.handle}
          </h3>
          <p className="muted">
            {account.followState ? (account.followState === "paused" ? "Paused" : "Followed") : "Pasted links only"} ·
            videos {account.videos} · transcripts checked {account.transcribed} · calls {account.calls}
            {account.lastCheckAt
              ? ` · last check ${account.lastCheckAt.toISOString().slice(0, 16).replace("T", " ")} UTC ${account.lastStatus ?? ""}${
                  account.lastErrorClass ? ` (${account.lastErrorClass})` : ""
                }${account.lastKept != null ? `, kept ${account.lastKept}, skipped ${account.lastSkipped ?? 0}` : ""}`
              : account.followState
                ? " · not checked yet"
                : ""}
          </p>
          {account.followState ? (
            <form className="inline-form" action={setTikTokFollowStateAction}>
              <input type="hidden" name="sourceAccountId" value={account.sourceAccountId} />
              <input type="hidden" name="state" value={account.followState === "paused" ? "active" : "paused"} />
              <button type="submit">{account.followState === "paused" ? "Resume" : "Pause"}</button>
            </form>
          ) : (
            <form className="inline-form" action={followTikTokCreatorAction}>
              <input type="hidden" name="profile" value={account.handle} />
              <button type="submit">Follow this creator</button>
            </form>
          )}
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
