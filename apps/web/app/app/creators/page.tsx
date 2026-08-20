import { EmptyState, LockedFeature } from "@/components/EmptyState";
import { loadAppAccess } from "@/lib/app-access";
import { getDb } from "@/lib/auth";
import { getCreatorAuthorityProfile, listCreators } from "@isp/db";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function CreatorsPage() {
  const { access } = await loadAppAccess();
  if (!access.hasCreatorAnalytics) {
    return (
      <LockedFeature
        title="Creators"
        body="Creator analytics are not on this plan. Authority profiles stay hidden until the creator_analytics entitlement is enabled."
      />
    );
  }
  const creators = await listCreators(getDb());
  const profiles = await Promise.all(creators.map((row) => getCreatorAuthorityProfile(getDb(), row.id)));

  return (
    <>
      <h1>Creators</h1>
      <p className="muted">
        Authority uses sample size, Wilson/Bayes intervals, and trust state. Raw hit rate is not shown without n.
      </p>
      {profiles.length === 0 ? (
        <EmptyState title="No creators" body="Source ingest and call extraction populate this directory." />
      ) : (
        <ul>
          {profiles.map((profile) => (
            <li key={profile.creator?.id}>
              <Link href={`/app/creators/${profile.creator?.id}`}>
                {profile.creator?.displayName ?? profile.creator?.id}
              </Link>
              {" — "}
              trust {profile.trustState} · n={profile.headline?.sampleSize ?? profile.resolved} · authority{" "}
              {profile.headline?.authorityScore ?? "low_confidence"}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
