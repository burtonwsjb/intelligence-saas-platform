import { PROVIDER_ADAPTER_NOTES, collectSystemHealth, listAdminProviders, listWebFeedSites } from "@isp/db";
import { requireGrantedOperator } from "@/lib/platform-admin";
import { getDb } from "@/lib/auth";
import {
  registerWebFeedSiteAction,
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
  searchParams: Promise<{ error?: string; website?: string }>;
}) {
  const operator = await requireGrantedOperator();
  const query = await searchParams;
  const db = operator.adminDb ?? getDb();
  const [health, providers, websites] = await Promise.all([
    collectSystemHealth(db),
    listAdminProviders(db),
    listWebFeedSites(db),
  ]);

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
      ) : query.error ? (
        <p className="form-error">Source control was rejected.</p>
      ) : null}
      {query.website === "added" ? <p role="status">Website registered. The next hourly feed run reads it.</p> : null}
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
