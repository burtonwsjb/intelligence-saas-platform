import { OPERATOR_TRUST_STATES, getCreatorAuthorityProfile, listCreators } from "@isp/db";
import { requireGrantedOperator } from "@/lib/platform-admin";
import { setCreatorTrustAction } from "@/app/admin-actions";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function AdminCreatorsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; q?: string; platform?: string }>;
}) {
  const operator = await requireGrantedOperator();
  const query = await searchParams;
  const db = operator.adminDb;
  if (!db) {
    return <p className="muted">Creator moderation needs the platform admin database role.</p>;
  }
  const creators = await listCreators(db);
  const profiles = await Promise.all(creators.map((row) => getCreatorAuthorityProfile(db, row.id)));
  const filtered = profiles.filter((profile) => {
    const q = query.q?.trim().toLowerCase();
    if (!q) {
      return true;
    }
    const hay = `${profile.creator?.displayName ?? ""} ${profile.creator?.id ?? ""}`.toLowerCase();
    return hay.includes(q);
  });

  return (
    <>
      <h1>Creators</h1>
      <p className="muted">
        Exclusion sets trust to excluded and keeps call history. This is not a delete. Future scoring skips
        excluded creators.
      </p>
      {query.error ? <p className="form-error">Trust update was rejected.</p> : null}
      <form className="inline-form">
        <label>
          Search
          <input name="q" defaultValue={query.q ?? ""} />
        </label>
        <button type="submit">Filter</button>
      </form>
      {filtered.map((profile) => (
        <section key={profile.creator?.id}>
          <h2>{profile.creator?.displayName ?? profile.creator?.id}</h2>
          <p>
            trust {profile.trustState} · calls {profile.totalCalls} · historical {profile.historicalCalls.length} ·
            last seen {profile.creator?.lastSeenAt?.toISOString() ?? "—"}
          </p>
          <form className="inline-form" action={setCreatorTrustAction}>
            <input type="hidden" name="creatorId" value={profile.creator?.id ?? ""} />
            <label>
              State
              <select name="trustState" defaultValue="excluded">
                {OPERATOR_TRUST_STATES.map((state) => (
                  <option key={state} value={state}>
                    {state}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Reason
              <input name="reason" required />
            </label>
            <button type="submit">Record trust</button>
          </form>
          <p>
            <Link href={`/app/creators/${profile.creator?.id}`}>Customer profile</Link>
          </p>
        </section>
      ))}
    </>
  );
}
