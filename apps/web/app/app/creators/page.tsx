import {
  addCreatorByLinkAction,
  removeCreatorListEntryAction,
  setCreatorPreferenceAction,
} from "@/app/creator-list-actions";
import { PreferenceButtons } from "@/components/CreatorPreferenceButtons";
import { Badge, StatusBadge } from "@/components/Badge";
import { EmptyState, LockedFeature } from "@/components/EmptyState";
import { ResultPager } from "@/components/ResultPager";
import { Tabs } from "@/components/Tabs";
import { loadAppAccess } from "@/lib/app-access";
import { getDb } from "@/lib/auth";
import { formatAge, monogram } from "@/lib/display";
import {
  LEADERBOARD_MIN_EVALUATED,
  getCreatorAuthorityProfile,
  getCreatorLeaderboard,
  listCreators,
  listTenantCreatorList,
  withOrganizationContext,
  type CreatorLeaderboardRow,
  type TenantCreatorListRow,
} from "@isp/db";
import Link from "next/link";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 12;

const TRUST_TEXT: Record<string, { label: string; tone: "good" | "warn" | "info" }> = {
  trusted: { label: "Trusted track record", tone: "good" },
  reliable: { label: "Reliable track record", tone: "good" },
  developing: { label: "Developing track record", tone: "info" },
  low_confidence: { label: "Too few evaluated calls", tone: "info" },
  unreliable: { label: "Unreliable track record", tone: "warn" },
  excluded: { label: "Excluded", tone: "warn" },
};

function compact(value: number | string | null | undefined): string {
  if (value == null) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

const STATUS_TEXT: Record<string, { label: string; tone: "good" | "warn" | "info" }> = {
  pending: { label: "Looking up", tone: "info" },
  resolved: { label: "Found", tone: "good" },
  not_found: { label: "Not found", tone: "warn" },
  blocked: { label: "Not available", tone: "warn" },
  failed: { label: "Lookup failed, will retry if you add it again", tone: "warn" },
};

const PLATFORM_TEXT: Record<string, string> = { youtube: "YouTube", reddit: "Reddit", web: "Website" };

export default async function CreatorsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; list?: string; error?: string; notice?: string }>;
}) {
  const { access, organizationId, userId } = await loadAppAccess();
  if (!access.hasCreatorAnalytics || !access.canViewAnalytics) {
    return (
      <LockedFeature
        title="Creators"
        body="Creator analytics are not enabled for this workspace. Authority profiles stay hidden until creator analytics are included in your plan."
      />
    );
  }
  const query = await searchParams;
  const listEntries = await withOrganizationContext(getDb(), { organizationId, userId }, listTenantCreatorList);
  const preferenceByCreator = new Map(
    listEntries.filter((row) => row.creatorId).map((row) => [row.creatorId!, row.preference]),
  );
  if (query.list === "mine") {
    return (
      <>
        <CreatorsHeader active="mine" />
        <MyList entries={listEntries} error={query.error} notice={query.notice} />
      </>
    );
  }
  if (query.list === "leaderboard") {
    const hidden = [...preferenceByCreator.entries()].filter(([, value]) => value === "hide").map(([id]) => id);
    const board = await getCreatorLeaderboard(getDb(), { game: "pokemon", hiddenCreatorIds: hidden });
    return (
      <>
        <CreatorsHeader active="leaderboard" />
        <Leaderboard ranked={board.ranked} notEnough={board.notEnoughCalls} preferences={preferenceByCreator} />
      </>
    );
  }
  // Hidden creators are left out of this workspace's directory.
  const all = (await listCreators(getDb()))
    .filter((row) => preferenceByCreator.get(row.id) !== "hide")
    .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime() || a.id.localeCompare(b.id));
  const hiddenCount = [...preferenceByCreator.values()].filter((value) => value === "hide").length;
  const pageCount = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const page = Math.max(1, Math.min(pageCount, Math.trunc(Number(query.page ?? 1)) || 1));
  // Only the visible page loads full authority profiles.
  const profiles = await Promise.all(
    all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((row) => getCreatorAuthorityProfile(getDb(), row.id)),
  );

  const returnTo = page > 1 ? `/app/creators?page=${page}` : "/app/creators";
  return (
    <>
      <CreatorsHeader active="all" />
      {query.error ? <p className="notice">{query.error}</p> : null}
      {hiddenCount > 0 ? (
        <p className="subtle">
          {hiddenCount} hidden {hiddenCount === 1 ? "creator is" : "creators are"} left out.{" "}
          <Link href="/app/creators?list=mine">Manage your list</Link>
        </p>
      ) : null}
      {profiles.length === 0 ? (
        <EmptyState title="No creators discovered yet" body="Creators appear here as topic discovery finds people talking about the market." />
      ) : (
        <ul className="panel-grid" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {profiles.map((profile) => {
            const id = profile.creator?.id ?? "";
            const name = profile.creator?.displayName ?? "Unnamed creator";
            const discovery = profile.discovery[0];
            const trust = TRUST_TEXT[profile.trustState] ?? { label: profile.trustState, tone: "info" as const };
            const showAuthority =
              profile.headline?.authorityScore != null && !["low_confidence", "excluded"].includes(profile.trustState);
            return (
              <li key={id} className="panel creator-tile" style={{ margin: 0 }}>
                <div className="creator-head">
                  <span className="avatar" aria-hidden="true">
                    {monogram(name)}
                  </span>
                  <span className="item-main">
                    <h3 className="card-title">
                      <Link href={`/app/creators/${encodeURIComponent(id)}`}>{name}</Link>
                    </h3>
                    <span className="subtle">
                      {discovery ? `${discovery.providerKey} · ` : ""}last seen {formatAge(profile.creator?.lastSeenAt)}
                    </span>
                  </span>
                </div>
                <div className="creator-stats">
                  <div>
                    Evaluated calls
                    <strong>{profile.resolved}</strong>
                  </div>
                  <div>
                    Authority
                    <strong>{showAuthority ? Math.round(Number(profile.headline!.authorityScore)) : "—"}</strong>
                  </div>
                  <div>
                    Reach
                    <strong>{compact(discovery?.reachSubscribers ?? discovery?.reachViews)}</strong>
                  </div>
                </div>
                <div className="badge-row">
                  <StatusBadge tone={trust.tone} label={trust.label} />
                  {discovery ? <Badge>{discovery.relevanceState.replaceAll("_", " ")}</Badge> : null}
                  {discovery?.lastMonitorSuccessAt ? (
                    <Badge>checked {formatAge(discovery.lastMonitorSuccessAt)}</Badge>
                  ) : null}
                  {profile.awaitingOutcome > 0 ? <Badge>{profile.awaitingOutcome} awaiting outcome</Badge> : null}
                  {preferenceByCreator.get(id) === "follow" ? <Badge tone="good">Following</Badge> : null}
                </div>
                <PreferenceButtons creatorId={id} current={preferenceByCreator.get(id)} returnTo={returnTo} />
              </li>
            );
          })}
        </ul>
      )}
      <ResultPager
        page={page}
        pageCount={pageCount}
        total={all.length}
        pageSize={PAGE_SIZE}
        noun="creators"
        hrefFor={(p) => (p > 1 ? `/app/creators?page=${p}` : "/app/creators")}
      />
    </>
  );
}

function CreatorsHeader({ active }: { active: "all" | "leaderboard" | "mine" }) {
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Creators</p>
          <h1>Who is talking</h1>
          <p className="muted">
            Reach shows how many people a creator reaches. Track record shows how their evaluated calls turned out. A large
            following is never counted as authority.
          </p>
        </div>
      </header>
      <Tabs
        label="Creator lists"
        active={active}
        tabs={[
          { key: "all", label: "All creators", href: "/app/creators" },
          { key: "leaderboard", label: "Leaderboard", href: "/app/creators?list=leaderboard" },
          { key: "mine", label: "Your list", href: "/app/creators?list=mine" },
        ]}
      />
    </>
  );
}

function percent(value: number | null) {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function platforms(row: CreatorLeaderboardRow) {
  return row.platforms.length ? row.platforms.map((key) => PLATFORM_TEXT[key] ?? key).join(", ") : "—";
}

function Leaderboard({
  ranked,
  notEnough,
  preferences,
}: {
  ranked: CreatorLeaderboardRow[];
  notEnough: CreatorLeaderboardRow[];
  preferences: Map<string, string>;
}) {
  const returnTo = "/app/creators?list=leaderboard";
  const name = (row: CreatorLeaderboardRow) => (
    <Link href={`/app/creators/${encodeURIComponent(row.creatorId)}`}>{row.name ?? "Unnamed creator"}</Link>
  );
  return (
    <>
      <p className="muted">
        Pokemon calls from the last 12 months. A call is evaluated once its horizon has passed and prices show whether
        it came true. Creators are ranked by the lower bound of their accuracy (so a few lucky calls do not outrank a long
        record) and need at least {LEADERBOARD_MIN_EVALUATED} evaluated calls to be ranked. Authority weight is how much
        their posts count in card sentiment.
      </p>
      {ranked.length === 0 ? (
        <EmptyState
          title="No ranked creators yet"
          body={`Creators are ranked once they have ${LEADERBOARD_MIN_EVALUATED} evaluated calls.`}
        />
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Creator</th>
              <th>Platforms</th>
              <th>Calls made</th>
              <th>Evaluated</th>
              <th>Came true</th>
              <th>Accuracy</th>
              <th>Authority weight</th>
              <th>Last call</th>
              <th>Your list</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((row) => (
              <tr key={row.creatorId}>
                <td>{row.rank}</td>
                <td>{name(row)}</td>
                <td>{platforms(row)}</td>
                <td>{row.callsMade}</td>
                <td>{row.callsEvaluated}</td>
                <td>{row.cameTrue}</td>
                <td>{percent(row.accuracy)}</td>
                <td>{row.authorityWeight == null ? "—" : row.authorityWeight.toFixed(3)}</td>
                <td>{row.lastCallAt ? formatAge(new Date(row.lastCallAt)) : "—"}</td>
                <td>
                  <PreferenceButtons creatorId={row.creatorId} current={preferences.get(row.creatorId)} returnTo={returnTo} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>Not enough calls yet</h2>
      {notEnough.length === 0 ? (
        <p className="subtle">None.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Creator</th>
              <th>Platforms</th>
              <th>Calls made</th>
              <th>Evaluated</th>
              <th>Came true</th>
              <th>Last call</th>
              <th>Your list</th>
            </tr>
          </thead>
          <tbody>
            {notEnough.map((row) => (
              <tr key={row.creatorId}>
                <td>{name(row)}</td>
                <td>{platforms(row)}</td>
                <td>{row.callsMade}</td>
                <td>{row.callsEvaluated}</td>
                <td>{row.cameTrue}</td>
                <td>{row.lastCallAt ? formatAge(new Date(row.lastCallAt)) : "—"}</td>
                <td>
                  <PreferenceButtons creatorId={row.creatorId} current={preferences.get(row.creatorId)} returnTo={returnTo} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function MyList({ entries, error, notice }: { entries: TenantCreatorListRow[]; error?: string; notice?: string }) {
  const following = entries.filter((row) => row.preference === "follow");
  const hidden = entries.filter((row) => row.preference === "hide");
  return (
    <>
      {error ? <p className="notice">{error}</p> : null}
      {notice === "queued" ? (
        <p className="notice info">
          Added. The next collection run looks the account up and starts following its new posts.
        </p>
      ) : notice === "added" ? (
        <p className="notice info">Added. This creator is already tracked, so their posts are followed from now on.</p>
      ) : null}
      <section className="panel" aria-labelledby="add-creator-heading">
        <h2 id="add-creator-heading">Add an influencer</h2>
        <form className="filter-form" action={addCreatorByLinkAction} style={{ margin: 0 }}>
          <label className="field" style={{ flex: "3 1 18rem" }}>
            YouTube channel or Reddit profile link
            <input name="link" type="text" required maxLength={300} placeholder="youtube.com/@channel or reddit.com/user/name" />
          </label>
          <label className="field">
            Platform
            <select name="platform" defaultValue="">
              <option value="">Detect from link</option>
              <option value="youtube">YouTube</option>
              <option value="reddit">Reddit</option>
            </select>
          </label>
          <button type="submit">Add</button>
        </form>
        <p className="subtle">
          Following a creator keeps their new posts collected. Their calls are still scored on accuracy like everyone
          else&apos;s; following never raises their weight.
        </p>
      </section>
      <section className="panel" aria-labelledby="following-heading">
        <h2 id="following-heading">Following</h2>
        {following.length === 0 ? (
          <EmptyState title="You are not following anyone yet" body="Add a link above, or press Follow on any creator." />
        ) : (
          <EntryList entries={following} />
        )}
      </section>
      <section className="panel" aria-labelledby="hidden-heading">
        <h2 id="hidden-heading">Hidden</h2>
        <p className="subtle">
          Hidden creators are left out of your creator list, card sentiment and card creator calls. Card scores are shared
          across workspaces and still include them.
        </p>
        {hidden.length === 0 ? (
          <EmptyState title="Nobody hidden" body="Use Hide from my views on a creator whose calls you do not want to see." />
        ) : (
          <EntryList entries={hidden} />
        )}
      </section>
    </>
  );
}

function EntryList({ entries }: { entries: TenantCreatorListRow[] }) {
  return (
    <ul className="item-list">
      {entries.map((entry) => {
        const status = STATUS_TEXT[entry.status] ?? { label: entry.status, tone: "info" as const };
        const name = entry.creatorName ?? entry.inputHandle ?? "Unnamed creator";
        return (
          <li key={entry.id}>
            <span className="item-main">
              <strong>
                {entry.creatorId ? <Link href={`/app/creators/${encodeURIComponent(entry.creatorId)}`}>{name}</Link> : name}
              </strong>
              <span className="subtle">
                {PLATFORM_TEXT[entry.platform] ?? entry.platform} · added {formatAge(entry.createdAt)}
              </span>
            </span>
            <span className="badge-row" style={{ alignItems: "center" }}>
              {entry.status !== "resolved" ? <StatusBadge tone={status.tone} label={status.label} /> : null}
              {entry.creatorId && entry.preference === "hide" ? (
                <form action={setCreatorPreferenceAction}>
                  <input type="hidden" name="creatorId" value={entry.creatorId} />
                  <input type="hidden" name="preference" value="follow" />
                  <input type="hidden" name="returnTo" value="/app/creators?list=mine" />
                  <button className="link-button text-link" type="submit">
                    Follow instead
                  </button>
                </form>
              ) : null}
              <form action={removeCreatorListEntryAction}>
                <input type="hidden" name="entryId" value={entry.id} />
                <input type="hidden" name="returnTo" value="/app/creators?list=mine" />
                <button className="link-button text-link" type="submit">
                  Remove
                </button>
              </form>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
