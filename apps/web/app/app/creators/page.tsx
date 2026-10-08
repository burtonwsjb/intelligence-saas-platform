import { Badge, StatusBadge } from "@/components/Badge";
import { EmptyState, LockedFeature } from "@/components/EmptyState";
import { ResultPager } from "@/components/ResultPager";
import { loadAppAccess } from "@/lib/app-access";
import { getDb } from "@/lib/auth";
import { formatAge, monogram } from "@/lib/display";
import { getCreatorAuthorityProfile, listCreators } from "@isp/db";
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

export default async function CreatorsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const { access } = await loadAppAccess();
  if (!access.hasCreatorAnalytics || !access.canViewAnalytics) {
    return (
      <LockedFeature
        title="Creators"
        body="Creator analytics are not enabled for this workspace. Authority profiles stay hidden until creator analytics are included in your plan."
      />
    );
  }
  const query = await searchParams;
  const all = (await listCreators(getDb())).sort(
    (a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime() || a.id.localeCompare(b.id),
  );
  const pageCount = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const page = Math.max(1, Math.min(pageCount, Math.trunc(Number(query.page ?? 1)) || 1));
  // Only the visible page loads full authority profiles.
  const profiles = await Promise.all(
    all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((row) => getCreatorAuthorityProfile(getDb(), row.id)),
  );

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
                </div>
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
